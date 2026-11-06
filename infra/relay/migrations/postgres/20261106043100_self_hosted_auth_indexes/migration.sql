CREATE INDEX IF NOT EXISTS relay_auth_grants_session ON relay_auth_grants(kind, (payload->>'sessionId'));
CREATE INDEX IF NOT EXISTS relay_auth_grants_device_code ON relay_auth_grants(kind, (payload->>'deviceUserCode'));
