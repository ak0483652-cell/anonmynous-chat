-- Supabase > SQL Editor me ye poora paste karke Run karo.

create table if not exists public.wallets (
  uid text primary key,                       -- Firebase uid (Gmail account)
  email text,
  credits integer not null default 0 check (credits >= 0),
  referral_code text unique not null,
  referred_by text references public.wallets(uid),
  referral_rewarded boolean not null default false,  -- referral bonus sirf 1 baar
  created_at timestamptz not null default now()
);

create table if not exists public.credit_log (
  id bigserial primary key,
  uid text not null,
  amount integer not null,                    -- + kamaye, - kate
  reason text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.reel_rewards (
  uid text not null,
  reel_id text not null,
  credits integer not null,
  created_at timestamptz not null default now(),
  primary key (uid, reel_id)                  -- ek reel ka credit ek user ko 1 baar
);

-- RLS on, koi policy nahi: browser (anon key) se koi in tables ko nahi chhu sakta.
alter table public.wallets enable row level security;
alter table public.credit_log enable row level security;
alter table public.reel_rewards enable row level security;

create or replace function public.wallet_login(p_uid text, p_email text, p_ref text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.wallets; v_referrer text; v_code text;
begin
  select * into w from public.wallets where uid = p_uid;
  if not found then
    if coalesce(p_ref, '') <> '' then
      select uid into v_referrer from public.wallets where referral_code = p_ref and uid <> p_uid;
    end if;
    loop
      v_code := substr(md5(random()::text || clock_timestamp()::text), 1, 8);
      exit when not exists (select 1 from public.wallets where referral_code = v_code);
    end loop;
    insert into public.wallets (uid, email, referral_code, referred_by)
    values (p_uid, p_email, v_code, v_referrer)
    on conflict (uid) do nothing;
    select * into w from public.wallets where uid = p_uid;
  end if;
  return jsonb_build_object(
    'credits', w.credits,
    'referralCode', w.referral_code,
    'pendingReferral', (w.referred_by is not null and not w.referral_rewarded)
  );
end $$;

create or replace function public.wallet_reel(p_uid text, p_reel text, p_credits int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_rows int; v_bal int;
begin
  insert into public.reel_rewards (uid, reel_id, credits) values (p_uid, p_reel, p_credits)
  on conflict do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    select credits into v_bal from public.wallets where uid = p_uid;
    return jsonb_build_object('rewarded', false, 'balance', coalesce(v_bal, 0));
  end if;
  update public.wallets set credits = credits + p_credits where uid = p_uid returning credits into v_bal;
  insert into public.credit_log (uid, amount, reason) values (p_uid, p_credits, 'reel:' || p_reel);
  return jsonb_build_object('rewarded', true, 'credits', p_credits, 'balance', coalesce(v_bal, 0));
end $$;

-- Balance se zyada kabhi nahi katega (min(balance, amount)).
create or replace function public.wallet_charge(p_uid text, p_amount int, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_old int; v_charged int; v_bal int;
begin
  select credits into v_old from public.wallets where uid = p_uid for update;
  if not found then return null; end if;
  v_charged := least(v_old, p_amount);
  update public.wallets set credits = credits - v_charged where uid = p_uid returning credits into v_bal;
  if v_charged > 0 then
    insert into public.credit_log (uid, amount, reason) values (p_uid, -v_charged, p_reason);
  end if;
  return jsonb_build_object('charged', v_charged, 'balance', v_bal);
end $$;

-- Referral: naya user pehli baar kisi se chat kare tab, sirf 1 baar (150 old, 100 new).
create or replace function public.wallet_referral(p_uid text, p_referrer_bonus int, p_new_bonus int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ref text; v_ref_bal int; v_new_bal int;
begin
  update public.wallets set referral_rewarded = true
  where uid = p_uid and referred_by is not null and referral_rewarded = false
  returning referred_by into v_ref;
  if v_ref is null then return null; end if;

  update public.wallets set credits = credits + p_referrer_bonus where uid = v_ref returning credits into v_ref_bal;
  update public.wallets set credits = credits + p_new_bonus where uid = p_uid returning credits into v_new_bal;
  insert into public.credit_log (uid, amount, reason) values
    (v_ref, p_referrer_bonus, 'referral:' || p_uid),
    (p_uid, p_new_bonus, 'referral-welcome');
  return jsonb_build_object('referrer', v_ref, 'referrerBalance', v_ref_bal, 'balance', v_new_bal);
end $$;

-- In functions ko sirf server (service_role) chala sakta hai.
revoke all on function public.wallet_login(text, text, text) from public, anon, authenticated;
revoke all on function public.wallet_reel(text, text, int) from public, anon, authenticated;
revoke all on function public.wallet_charge(text, int, text) from public, anon, authenticated;
revoke all on function public.wallet_referral(text, int, int) from public, anon, authenticated;
grant execute on function public.wallet_login(text, text, text) to service_role;
grant execute on function public.wallet_reel(text, text, int) to service_role;
grant execute on function public.wallet_charge(text, int, text) to service_role;
grant execute on function public.wallet_referral(text, int, int) to service_role;
