CREATE TABLE relay_auth_grants (hash varchar(64) PRIMARY KEY, kind varchar(16) NOT NULL, access_hash varchar(64), expires_at varchar(64) NOT NULL, payload jsonb NOT NULL);
CREATE UNIQUE INDEX relay_auth_grants_access ON relay_auth_grants(access_hash);
CREATE INDEX relay_auth_grants_expiry ON relay_auth_grants(expires_at);
