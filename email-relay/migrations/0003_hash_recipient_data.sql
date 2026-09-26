DROP TABLE email_verifications;

CREATE TABLE email_verifications (
    email_hash TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
);

DELETE FROM rate_limits;
