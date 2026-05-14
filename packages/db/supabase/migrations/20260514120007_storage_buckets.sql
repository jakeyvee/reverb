-- Private storage for raw lesson audio, generated dialogue clips, and the TTS
-- audio cache. All three are household-scoped via path prefix:
--
--   {bucket}/{household_id}/...
--
-- The first folder of the object name must match the caller's household. The
-- service role bypasses RLS, so background workers can write anywhere.

insert into storage.buckets (id, name, public)
values
  ('lesson-audio', 'lesson-audio', false),
  ('lesson-clips', 'lesson-clips', false),
  ('tts-cache', 'tts-cache', false)
on conflict (id) do nothing;

create policy "reverb_storage_select_household" on storage.objects
  for select to authenticated
  using (
    bucket_id in ('lesson-audio', 'lesson-clips', 'tts-cache')
    and (storage.foldername(name))[1] = public.current_household_id()::text
  );

create policy "reverb_storage_insert_household" on storage.objects
  for insert to authenticated
  with check (
    bucket_id in ('lesson-audio', 'lesson-clips', 'tts-cache')
    and (storage.foldername(name))[1] = public.current_household_id()::text
  );

create policy "reverb_storage_update_household" on storage.objects
  for update to authenticated
  using (
    bucket_id in ('lesson-audio', 'lesson-clips', 'tts-cache')
    and (storage.foldername(name))[1] = public.current_household_id()::text
  )
  with check (
    bucket_id in ('lesson-audio', 'lesson-clips', 'tts-cache')
    and (storage.foldername(name))[1] = public.current_household_id()::text
  );

create policy "reverb_storage_delete_household" on storage.objects
  for delete to authenticated
  using (
    bucket_id in ('lesson-audio', 'lesson-clips', 'tts-cache')
    and (storage.foldername(name))[1] = public.current_household_id()::text
  );
