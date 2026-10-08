-- The language the AI answers in unless the customer clearly wrote in another one. Without a
-- stated default the model guesses from the message, and a one-word greeting carries almost no
-- signal — "Hello" was answered in Portuguese to Bengali-speaking customers.
ALTER TABLE "AiSettings" ADD COLUMN IF NOT EXISTS "defaultReplyLanguage" TEXT NOT NULL DEFAULT 'Bengali (Bangla)';
