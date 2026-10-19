-- Strangely wallet schema
-- Supabase > SQL Editor > New query > ye poora paste karo > Run
-- Rate: 10,000 credits = Rs 39  =>  100 credits = 39 paise (functions me 39/100 isi liye hai)

create table if not exists wallets (
  uid text primary key,
  credits bigint not null default 0 check (credits >= 0),        -- baat karne ke credits (withdraw nahi hote)
  earn_credits bigint not null default 0 check (earn_credits >= 0), -- listener kamaai (hold khulne ke baad, withdraw ho sakti hai)
  code text unique,
  referred_by text,
  referral_rewarded boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists ledger (
  id bigserial primary key,
  uid text not null,
  kind text not null,
  ref text not null,
  credits_delta bigint not null default 0,
  earn_delta bigint not null default 0,
  created_at timestamptz not null default now(),
  unique (kind, ref)  -- same cheez do baar credit nahi hoti (webhook retry safe)
);

create table if not exists earn_lots (
  id bigserial primary key,
  uid text not null,
  credits bigint not null check (credits > 0),
  available_at timestamptz not null,   -- fixed hold: sirf time se khulta hai, kisi shart se nahi
  released boolean not null default false,
  ref text not null unique
);

create table if not exists recharges (
  order_id text primary key,
  uid text not null,
  pack text not null,
  amount_paise integer not null,
  credits bigint not null,
  status text not null default 'created',
  payment_id text,
  created_at timestamptz not null default now()
);

create table if not exists withdrawals (
  id bigserial primary key,
  uid text not null,
  credits bigint not null,
  amount_paise integer not null,
  upi text not null,
  status text not null default 'requested',  -- requested | paid | rejected
  note text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

-- Koi bhi policy nahi => browser (anon key) se kuch nahi dikhta. Sirf server ki service key chalti hai.
alter table wallets enable row level security;
alter table ledger enable row level security;
alter table earn_lots enable row level security;
alter table recharges enable row level security;
alter table withdrawals enable row level security;

-- Wallet padho. Pehle matured earnings (3 din baad wali) apne aap release ho jaati hain.
create or replace function wallet_get(p_uid text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare w wallets; pend bigint; rel bigint;
begin
  insert into wallets(uid, code) values (p_uid, upper(substr(md5(p_uid), 1, 8))) on conflict (uid) do nothing;
  with r as (
    update earn_lots set released = true
    where uid = p_uid and not released and available_at <= now()
    returning credits
  ) select coalesce(sum(credits), 0) into rel from r;
  if rel > 0 then
    update wallets set earn_credits = earn_credits + rel where uid = p_uid;
  end if;
  select * into w from wallets where uid = p_uid;
  select coalesce(sum(credits), 0) into pend from earn_lots where uid = p_uid and not released;
  return jsonb_build_object('uid', w.uid, 'credits', w.credits, 'earn_credits', w.earn_credits,
    'pending_credits', pend, 'code', w.code, 'referred_by', w.referred_by, 'referral_rewarded', w.referral_rewarded);
end $$;

-- Credits/earnings me delta lagao (ek hi (kind, ref) sirf ek baar chalta hai).
create or replace function wallet_apply(p_uid text, p_credits bigint, p_earn bigint, p_kind text, p_ref text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare w wallets;
begin
  insert into wallets(uid, code) values (p_uid, upper(substr(md5(p_uid), 1, 8))) on conflict (uid) do nothing;
  begin
    insert into ledger(uid, kind, ref, credits_delta, earn_delta) values (p_uid, p_kind, p_ref, p_credits, p_earn);
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'reason', 'duplicate');
  end;
  select * into w from wallets where uid = p_uid for update;
  if w.credits + p_credits < 0 or w.earn_credits + p_earn < 0 then
    delete from ledger where kind = p_kind and ref = p_ref;
    return jsonb_build_object('ok', false, 'reason', 'insufficient');
  end if;
  update wallets set credits = credits + p_credits, earn_credits = earn_credits + p_earn where uid = p_uid returning * into w;
  return jsonb_build_object('ok', true, 'credits', w.credits, 'earn_credits', w.earn_credits);
end $$;

-- Listener ki kamaai hold me daalo (p_available = abhi + 3 din).
create or replace function earn_lot_add(p_uid text, p_credits bigint, p_available timestamptz, p_ref text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  insert into wallets(uid, code) values (p_uid, upper(substr(md5(p_uid), 1, 8))) on conflict (uid) do nothing;
  insert into earn_lots(uid, credits, available_at, ref) values (p_uid, p_credits, p_available, p_ref)
    on conflict (ref) do nothing;
  if not found then return jsonb_build_object('ok', false, 'reason', 'duplicate'); end if;
  insert into ledger(uid, kind, ref, earn_delta) values (p_uid, 'listen_earning', p_ref, p_credits)
    on conflict (kind, ref) do nothing;
  return jsonb_build_object('ok', true);
end $$;

-- Recharge paid mark karke credits do (sirf ek baar).
create or replace function recharge_credit(p_order text, p_payment text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r recharges; paidcount integer;
begin
  update recharges set status = 'paid', payment_id = p_payment
    where order_id = p_order and status = 'created' returning * into r;
  if r.order_id is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_or_already_paid');
  end if;
  perform wallet_apply(r.uid, r.credits, 0, 'recharge', r.order_id);
  select count(*) into paidcount from recharges where uid = r.uid and status = 'paid';
  return jsonb_build_object('ok', true, 'uid', r.uid, 'credits', r.credits, 'first', paidcount = 1);
end $$;

-- Withdrawal request: sirf available (hold khul chuki) earnings se, min amount ke saath.
create or replace function withdraw_request(p_uid text, p_upi text, p_min_paise integer) returns jsonb
language plpgsql security definer set search_path = public as $$
declare w wallets; paise integer; used bigint; wid bigint;
begin
  perform wallet_get(p_uid);
  select * into w from wallets where uid = p_uid for update;
  paise := floor(w.earn_credits * 39 / 100.0)::integer;
  if paise < p_min_paise then
    return jsonb_build_object('ok', false, 'reason', 'below_minimum', 'paise', paise);
  end if;
  used := ceil(paise * 100 / 39.0)::bigint;
  if used > w.earn_credits then used := w.earn_credits; end if;
  update wallets set earn_credits = earn_credits - used where uid = p_uid;
  insert into withdrawals(uid, credits, amount_paise, upi) values (p_uid, used, paise, p_upi) returning id into wid;
  insert into ledger(uid, kind, ref, earn_delta) values (p_uid, 'withdraw_request', wid::text, -used);
  return jsonb_build_object('ok', true, 'id', wid, 'paise', paise);
end $$;

-- Owner: paid ya reject (reject par paisa wapas earnings me).
create or replace function withdraw_resolve(p_id bigint, p_action text, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare w withdrawals;
begin
  select * into w from withdrawals where id = p_id for update;
  if not found or w.status <> 'requested' then
    return jsonb_build_object('ok', false, 'reason', 'not_pending');
  end if;
  if p_action = 'paid' then
    update withdrawals set status = 'paid', paid_at = now(), note = p_note where id = p_id;
  elsif p_action = 'reject' then
    update withdrawals set status = 'rejected', note = p_note where id = p_id;
    update wallets set earn_credits = earn_credits + w.credits where uid = w.uid;
    insert into ledger(uid, kind, ref, earn_delta) values (w.uid, 'withdraw_rejected', p_id::text, w.credits);
  else
    return jsonb_build_object('ok', false, 'reason', 'bad_action');
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Referral code lagao (sirf pehle recharge se pehle, apna code nahi).
create or replace function referral_set(p_uid text, p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare mew wallets; refw wallets; paid integer;
begin
  perform wallet_get(p_uid);
  select * into mew from wallets where uid = p_uid for update;
  if mew.referred_by is not null then return jsonb_build_object('ok', false, 'reason', 'already_set'); end if;
  select count(*) into paid from recharges where uid = p_uid and status = 'paid';
  if paid > 0 then return jsonb_build_object('ok', false, 'reason', 'already_recharged'); end if;
  select * into refw from wallets where code = upper(p_code);
  if not found then return jsonb_build_object('ok', false, 'reason', 'bad_code'); end if;
  if refw.uid = p_uid then return jsonb_build_object('ok', false, 'reason', 'self'); end if;
  update wallets set referred_by = refw.uid where uid = p_uid;
  return jsonb_build_object('ok', true);
end $$;

-- Pehle recharge par referral reward sirf ek baar claim ho.
create or replace function referral_claim(p_uid text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r text;
begin
  update wallets set referral_rewarded = true
    where uid = p_uid and referred_by is not null and not referral_rewarded returning referred_by into r;
  if r is null then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'referrer', r);
end $$;
