import { describe, expect, it } from 'vitest';
import { corsAllowed } from '../src/app.js';

describe('CORS cho điện thoại trong mạng nội bộ', () => {
  it('cho địa chỉ trong MEDONE_WEB_ORIGIN và địa chỉ mạng nội bộ, chặn địa chỉ ngoài', () => {
    expect(corsAllowed('http://localhost:3000')).toBe(true);
    expect(corsAllowed('http://192.168.10.75:3000')).toBe(true);
    expect(corsAllowed('http://10.0.0.5:3000')).toBe(true);
    expect(corsAllowed('http://172.20.1.2:3000')).toBe(true);
    expect(corsAllowed('http://medone.local:3000')).toBe(true);
    expect(corsAllowed('https://evil.example.com')).toBe(false);
    expect(corsAllowed('http://172.32.0.1:3000')).toBe(false);
  });
});
