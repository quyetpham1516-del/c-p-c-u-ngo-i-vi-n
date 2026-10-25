import { describe, expect, it } from 'vitest';
import { setEnvVars } from '../src/tools/keycloak-sync.js';

describe('ghi biến đăng nhập một lần vào .env', () => {
  it('thay biến đã có, thêm biến mới, giữ nguyên phần còn lại', () => {
    const before = 'DATABASE_URL=postgres://x\nMEDONE_OIDC_ISSUER=https://cu/realms/medone\n# ghi chú\n';
    const after = setEnvVars(before, { MEDONE_OIDC_ISSUER: 'https://moi:3443/auth/realms/medone', MEDONE_KEYCLOAK_PORT: '8180' });
    expect(after).toContain('DATABASE_URL=postgres://x\n');
    expect(after).toContain('# ghi chú');
    expect(after.match(/MEDONE_OIDC_ISSUER=/g)).toHaveLength(1);
    expect(after).toContain('MEDONE_OIDC_ISSUER=https://moi:3443/auth/realms/medone');
    expect(after).toMatch(/\nMEDONE_KEYCLOAK_PORT=8180\n$/);
    expect(setEnvVars(after, { MEDONE_KEYCLOAK_PORT: '8180' })).toBe(after);
  });
});
