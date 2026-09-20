ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS assessment_status text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS assessment_json text;
