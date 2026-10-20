-- Strangely Reels schema
-- Supabase > SQL Editor > New query > ye poora paste karo > Run
-- Safe hai: dobara run karne se kuch nahi bigadta.

create table if not exists reels (
  id uuid primary key default gen_random_uuid(),
  video_url text not null,
  poster_url text,
  caption text not null default '',
  like_count integer not null default 0 check (like_count >= 0),
  comment_count integer not null default 0 check (comment_count >= 0),
  created_at timestamptz not null default now()
);
create index if not exists reels_created_idx on reels (created_at desc);

-- Ek user ek reel ko ek hi baar like kar sakta hai (primary key yahi rule lagati hai)
create table if not exists reel_likes (
  reel_id uuid not null references reels(id) on delete cascade,
  uid text not null,
  created_at timestamptz not null default now(),
  primary key (reel_id, uid)
);

create table if not exists reel_comments (
  id uuid primary key default gen_random_uuid(),
  reel_id uuid not null references reels(id) on delete cascade,
  uid text not null,
  author text not null,
  body text not null check (char_length(body) between 1 and 300),
  report_count integer not null default 0,
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists reel_comments_reel_idx on reel_comments (reel_id, created_at desc);

create table if not exists reel_comment_reports (
  comment_id uuid not null references reel_comments(id) on delete cascade,
  uid text not null,
  created_at timestamptz not null default now(),
  primary key (comment_id, uid)
);

-- Koi bhi browser se seedha table na khol sake: RLS on, policy koi nahi.
-- Sirf tumhara server (service_role key) in tables tak pahunchta hai.
alter table reels enable row level security;
alter table reel_likes enable row level security;
alter table reel_comments enable row level security;
alter table reel_comment_reports enable row level security;

create or replace function reel_like(p_reel uuid, p_uid text) returns integer
language plpgsql as $$
declare n integer;
begin
  insert into reel_likes (reel_id, uid) values (p_reel, p_uid) on conflict do nothing;
  if found then
    update reels set like_count = like_count + 1 where id = p_reel;
  end if;
  select like_count into n from reels where id = p_reel;
  return coalesce(n, 0);
end $$;

create or replace function reel_unlike(p_reel uuid, p_uid text) returns integer
language plpgsql as $$
declare n integer;
begin
  delete from reel_likes where reel_id = p_reel and uid = p_uid;
  if found then
    update reels set like_count = greatest(like_count - 1, 0) where id = p_reel;
  end if;
  select like_count into n from reels where id = p_reel;
  return coalesce(n, 0);
end $$;

create or replace function reel_comment_add(p_reel uuid, p_uid text, p_author text, p_body text) returns reel_comments
language plpgsql as $$
declare c reel_comments;
begin
  insert into reel_comments (reel_id, uid, author, body) values (p_reel, p_uid, p_author, p_body) returning * into c;
  update reels set comment_count = comment_count + 1 where id = p_reel;
  return c;
end $$;

create or replace function reel_comment_delete(p_comment uuid) returns boolean
language plpgsql as $$
declare c reel_comments;
begin
  delete from reel_comments where id = p_comment returning * into c;
  if not found then return false; end if;
  if not c.hidden then
    update reels set comment_count = greatest(comment_count - 1, 0) where id = c.reel_id;
  end if;
  return true;
end $$;

-- Report: ek user ek comment ko ek baar report kar sakta hai. p_threshold report ke baad comment chhup jaata hai.
create or replace function reel_comment_report(p_comment uuid, p_uid text, p_threshold integer) returns integer
language plpgsql as $$
declare c reel_comments; n integer;
begin
  insert into reel_comment_reports (comment_id, uid) values (p_comment, p_uid) on conflict do nothing;
  if found then
    update reel_comments set report_count = report_count + 1 where id = p_comment returning * into c;
    if c.report_count >= p_threshold and not c.hidden then
      update reel_comments set hidden = true where id = p_comment;
      update reels set comment_count = greatest(comment_count - 1, 0) where id = c.reel_id;
    end if;
  end if;
  select report_count into n from reel_comments where id = p_comment;
  return coalesce(n, 0);
end $$;

-- RPC functions ko anon/public se band rakho (sirf service_role chala sakta hai)
revoke all on function reel_like(uuid, text) from public, anon, authenticated;
revoke all on function reel_unlike(uuid, text) from public, anon, authenticated;
revoke all on function reel_comment_add(uuid, text, text, text) from public, anon, authenticated;
revoke all on function reel_comment_delete(uuid) from public, anon, authenticated;
revoke all on function reel_comment_report(uuid, text, integer) from public, anon, authenticated;
