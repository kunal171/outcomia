-- Optional public links on a profile. Handles are stored without '@' or a
-- site prefix; the app builds each link. Every value is checked here as well
-- as in the API, so stored data is always safe to render as a link.
ALTER TABLE profiles
    ADD COLUMN location TEXT CHECK (location IS NULL OR char_length(location) <= 40),
    ADD COLUMN website TEXT CHECK (website IS NULL OR (char_length(website) <= 120 AND website ~ '^https://[^[:space:]<>"]+$')),
    ADD COLUMN telegram TEXT CHECK (telegram IS NULL OR telegram ~ '^[A-Za-z0-9_]{5,32}$'),
    ADD COLUMN instagram TEXT CHECK (instagram IS NULL OR instagram ~ '^[A-Za-z0-9._]{1,30}$'),
    ADD COLUMN linkedin TEXT CHECK (linkedin IS NULL OR linkedin ~ '^[A-Za-z0-9-]{3,100}$'),
    ADD COLUMN discord TEXT CHECK (discord IS NULL OR discord ~ '^[a-z0-9_.]{2,32}$'),
    ADD COLUMN github TEXT CHECK (github IS NULL OR github ~ '^[A-Za-z0-9-]{1,39}$'),
    ADD COLUMN youtube TEXT CHECK (youtube IS NULL OR youtube ~ '^[A-Za-z0-9._-]{3,30}$');
