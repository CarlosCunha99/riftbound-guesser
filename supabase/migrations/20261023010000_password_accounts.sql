-- Username + password accounts without real emails.
-- Supabase Auth needs an email, so each username maps to "<username>@riftguessr.app". GoTrue's own
-- sign-up would try to validate that domain and send a confirmation mail, so accounts are created here
-- instead, already confirmed. Signing in still goes through the normal password login.

create extension if not exists pgcrypto with schema extensions;

create or replace function public.register_account(p_username text, p_password text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_name  text := lower(btrim(coalesce(p_username, '')));
  v_email text;
  v_uid   uuid := auth.uid();
  v_hash  text;
begin
  if v_name !~ '^[a-z0-9_-]{3,16}$' then
    raise exception 'Usernames are 3-16 letters, numbers, - or _' using errcode = '22023';
  end if;
  if not public.nickname_is_clean(v_name) then
    raise exception 'Please pick a different username' using errcode = '22023';
  end if;
  if length(coalesce(p_password, '')) < 8 or length(p_password) > 72 then
    raise exception 'Passwords need 8-72 characters' using errcode = '22023';
  end if;

  -- Rough global brake on account creation, since this is callable without a session.
  if (select count(*) from auth.users u
      where u.email like '%@riftguessr.app' and u.created_at > now() - interval '1 minute') >= 20 then
    raise exception 'Too many new accounts right now, try again in a minute' using errcode = '22023';
  end if;

  v_email := v_name || '@riftguessr.app';
  perform pg_advisory_xact_lock(hashtext(v_email));
  if exists (select 1 from auth.users u where lower(u.email) = v_email) then
    raise exception 'That username is taken' using errcode = '23505';
  end if;

  v_hash := extensions.crypt(p_password, extensions.gen_salt('bf', 10));

  if v_uid is not null then
    -- A guest keeps their user id (and so their results and nickname).
    if not exists (select 1 from auth.users u where u.id = v_uid and u.is_anonymous) then
      raise exception 'You already have an account' using errcode = '22023';
    end if;
    update auth.users u
       set email = v_email,
           encrypted_password = v_hash,
           email_confirmed_at = now(),
           is_anonymous = false,
           raw_app_meta_data = coalesce(u.raw_app_meta_data, '{}'::jsonb) || '{"provider":"email","providers":["email"]}'::jsonb,
           confirmation_token = coalesce(u.confirmation_token, ''),
           recovery_token = coalesce(u.recovery_token, ''),
           email_change_token_new = coalesce(u.email_change_token_new, ''),
           email_change = coalesce(u.email_change, ''),
           updated_at = now()
     where u.id = v_uid;
  else
    v_uid := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, is_anonymous, created_at, updated_at,
                            confirmation_token, recovery_token, email_change_token_new, email_change)
    values ('00000000-0000-0000-0000-000000000000', v_uid, 'authenticated', 'authenticated', v_email, v_hash, now(),
            '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false, now(), now(),
            '', '', '', '');
  end if;

  insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (v_uid::text, v_uid,
          jsonb_build_object('sub', v_uid::text, 'email', v_email, 'email_verified', true, 'phone_verified', false),
          'email', now(), now(), now());
end;
$$;

revoke execute on function public.register_account(text, text) from public;
grant execute on function public.register_account(text, text) to anon, authenticated;
