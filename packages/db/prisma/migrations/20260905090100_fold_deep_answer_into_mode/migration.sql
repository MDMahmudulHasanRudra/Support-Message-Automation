-- deepAnswerEnabled is now expressed by the response mode: two controls for one behaviour is the
-- dead-setting problem this project keeps removing. Anyone who had switched it on keeps the
-- behaviour — their mode moves up to the equivalent that includes reading the product source.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'AiSettings' AND column_name = 'deepAnswerEnabled'
  ) THEN
    UPDATE "AiSettings"
    SET "aiResponseMode" = CASE
          WHEN "aiResponseMode" = 'KNOWLEDGE_PLUS_GENERAL' THEN 'KNOWLEDGE_FORGE_GENERAL'::"AiResponseMode"
          ELSE 'KNOWLEDGE_PLUS_FORGE'::"AiResponseMode"
        END
    WHERE "deepAnswerEnabled" = true;

    ALTER TABLE "AiSettings" DROP COLUMN "deepAnswerEnabled";
  END IF;
END $$;
