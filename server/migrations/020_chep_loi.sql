-- Chép lời cuộc gọi từ ghi âm (ASR) bằng máy chép lời đơn vị tự cài (whisper.cpp, faster-whisper...), giao tiếp chuẩn /audio/transcriptions
ALTER TABLE calls
  ADD COLUMN transcript text,
  ADD COLUMN transcript_status text CHECK (transcript_status IN ('cho', 'xong', 'loi')),
  ADD COLUMN transcript_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN transcript_at timestamptz,
  ADD COLUMN transcript_model text,
  ADD COLUMN transcript_error text;
CREATE INDEX calls_transcript_queue ON calls(ringing_at) WHERE transcript_status = 'cho';
-- Tìm theo nội dung lời thoại (QLCL rà soát cuộc gọi có cụm từ "ngừng thở", "co giật"...)
CREATE INDEX calls_transcript_search ON calls USING gin (to_tsvector('simple', coalesce(transcript, '')));
