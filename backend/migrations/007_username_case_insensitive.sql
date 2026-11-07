-- migrations/007_username_case_insensitive.sql
-- Login resolves usernames case-insensitively, so uniqueness must use the
-- same semantics. Refuse startup rather than silently allowing ambiguous
-- accounts if legacy rows already differ only by letter case.
DO $$
BEGIN
  IF EXISTS (
    SELECT lower(username)
    FROM users
    GROUP BY lower(username)
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate usernames differ only by case; resolve them before applying migration 007';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower_unique
  ON users (lower(username));
