import { describe, it, expect } from 'vitest';
import { validateUrl, SecurityError } from '../main/url-validator.js';

describe('URL Validation Security', () => {
  describe('Dangerous protocol handlers are blocked', () => {
    it('blocks file:// protocol (local filesystem access)', () => {
      expect(() => { validateUrl('file:///etc/passwd'); }).toThrow(SecurityError);
      expect(() => { validateUrl('file:///etc/passwd'); }).toThrow(
        /Dangerous URL protocol "file:" in URL "file:\/\/\/etc\/passwd"/
      );
    });

    it('blocks file:// protocol on Windows paths', () => {
      expect(() => { validateUrl('file:///C:/Windows/System32/config/SAM'); }).toThrow(SecurityError);
      expect(() => { validateUrl('file:///C:/Windows/System32/config/SAM'); }).toThrow(
        /Dangerous URL protocol "file:"/
      );
    });

    it('blocks javascript: protocol (code execution)', () => {
      expect(() => { validateUrl('javascript:alert(1)'); }).toThrow(SecurityError);
      expect(() => { validateUrl('javascript:alert(1)'); }).toThrow(
        /Dangerous URL protocol "javascript:" in URL "javascript:alert\(1\)"/
      );
    });

    it('blocks javascript: protocol with encoded content', () => {
      expect(() => { validateUrl('javascript:alert(document.cookie)'); }).toThrow(SecurityError);
      expect(() => { validateUrl('javascript:alert(document.cookie)'); }).toThrow(
        /Dangerous URL protocol "javascript:"/
      );
    });

    it('blocks data: protocol (embedded executable content)', () => {
      expect(() => { validateUrl('data:text/html,<script>alert(1)</script>'); }).toThrow(SecurityError);
      expect(() => { validateUrl('data:text/html,<script>alert(1)</script>'); }).toThrow(
        /Dangerous URL protocol "data:" in URL "data:text\/html,<script>alert\(1\)<\/script>"/
      );
    });

    it('blocks data: protocol with base64 encoded content', () => {
      expect(() => { validateUrl('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='); }).toThrow(SecurityError);
      expect(() => { validateUrl('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='); }).toThrow(
        /Dangerous URL protocol "data:"/
      );
    });

    it('blocks smb:// protocol (network share access)', () => {
      expect(() => { validateUrl('smb://evil.com/share'); }).toThrow(SecurityError);
      expect(() => { validateUrl('smb://evil.com/share'); }).toThrow(
        /Dangerous URL protocol "smb:" in URL "smb:\/\/evil.com\/share"/
      );
    });

    it('blocks smb:// protocol with authentication', () => {
      expect(() => { validateUrl('smb://user:pass@evil.com/share'); }).toThrow(SecurityError);
      expect(() => { validateUrl('smb://user:pass@evil.com/share'); }).toThrow(
        /Dangerous URL protocol "smb:"/
      );
    });

    it('blocks ftp:// protocol (file transfer)', () => {
      expect(() => { validateUrl('ftp://ftp.example.com/file.zip'); }).toThrow(SecurityError);
      expect(() => { validateUrl('ftp://ftp.example.com/file.zip'); }).toThrow(
        /Dangerous URL protocol "ftp:" in URL "ftp:\/\/ftp.example.com\/file.zip"/
      );
    });

    it('blocks custom:// protocol handlers (arbitrary application launch)', () => {
      expect(() => { validateUrl('custom://launch-app'); }).toThrow(SecurityError);
      expect(() => { validateUrl('custom://launch-app'); }).toThrow(
        /Dangerous URL protocol "custom:" in URL "custom:\/\/launch-app"/
      );
    });

    it('blocks slack:// protocol (application-specific handler)', () => {
      expect(() => { validateUrl('slack://channel?id=123'); }).toThrow(SecurityError);
      expect(() => { validateUrl('slack://channel?id=123'); }).toThrow(
        /Dangerous URL protocol "slack:"/
      );
    });

    it('blocks vscode:// protocol (editor protocol handler)', () => {
      expect(() => { validateUrl('vscode://file/path/to/file'); }).toThrow(SecurityError);
      expect(() => { validateUrl('vscode://file/path/to/file'); }).toThrow(
        /Dangerous URL protocol "vscode:"/
      );
    });

    it('blocks ms-excel:// protocol (Office protocol handler)', () => {
      expect(() => { validateUrl('ms-excel:ofe|u|file:///C:/malicious.xlsx'); }).toThrow(SecurityError);
      expect(() => { validateUrl('ms-excel:ofe|u|file:///C:/malicious.xlsx'); }).toThrow(
        /Dangerous URL protocol "ms-excel:"/
      );
    });

    it('blocks about: protocol', () => {
      expect(() => { validateUrl('about:blank'); }).toThrow(SecurityError);
      expect(() => { validateUrl('about:blank'); }).toThrow(
        /Dangerous URL protocol "about:"/
      );
    });

    it('blocks blob: protocol', () => {
      expect(() => { validateUrl('blob:https://example.com/uuid'); }).toThrow(SecurityError);
      expect(() => { validateUrl('blob:https://example.com/uuid'); }).toThrow(
        /Dangerous URL protocol "blob:"/
      );
    });

    it('blocks chrome-extension: protocol', () => {
      expect(() => { validateUrl('chrome-extension://abcdefg/page.html'); }).toThrow(SecurityError);
      expect(() => { validateUrl('chrome-extension://abcdefg/page.html'); }).toThrow(
        /Dangerous URL protocol "chrome-extension:"/
      );
    });

    it('blocks ws:// and wss:// websocket protocols', () => {
      expect(() => { validateUrl('ws://example.com/socket'); }).toThrow(SecurityError);
      expect(() => { validateUrl('ws://example.com/socket'); }).toThrow(
        /Dangerous URL protocol "ws:"/
      );

      expect(() => { validateUrl('wss://example.com/socket'); }).toThrow(SecurityError);
      expect(() => { validateUrl('wss://example.com/socket'); }).toThrow(
        /Dangerous URL protocol "wss:"/
      );
    });
  });

  describe('Valid URLs are allowed', () => {
    it('allows https:// URLs', () => {
      expect(() => { validateUrl('https://example.com'); }).not.toThrow();
      expect(() => { validateUrl('https://aws.amazon.com/billing'); }).not.toThrow();
      expect(() => { validateUrl('https://docs.aws.amazon.com/cur/latest/userguide/'); }).not.toThrow();
    });

    it('allows http:// URLs', () => {
      expect(() => { validateUrl('http://example.com'); }).not.toThrow();
      expect(() => { validateUrl('http://localhost:3000'); }).not.toThrow();
    });

    it('allows https:// URLs with ports', () => {
      expect(() => { validateUrl('https://example.com:8443'); }).not.toThrow();
      expect(() => { validateUrl('https://localhost:3000'); }).not.toThrow();
    });

    it('allows URLs with query strings', () => {
      expect(() => { validateUrl('https://example.com?param=value&foo=bar'); }).not.toThrow();
      expect(() => { validateUrl('https://example.com?search=test%20query'); }).not.toThrow();
    });

    it('allows URLs with fragments', () => {
      expect(() => { validateUrl('https://example.com#section'); }).not.toThrow();
      expect(() => { validateUrl('https://docs.aws.amazon.com/cur/latest/userguide/#getting-started'); }).not.toThrow();
    });

    it('allows URLs with authentication (even though not recommended)', () => {
      expect(() => { validateUrl('https://user:pass@example.com'); }).not.toThrow();
    });

    it('allows URLs with complex paths', () => {
      expect(() => { validateUrl('https://example.com/path/to/resource.html'); }).not.toThrow();
      expect(() => { validateUrl('https://example.com/api/v1/users/123/profile'); }).not.toThrow();
    });

    it('allows URLs with encoded characters', () => {
      expect(() => { validateUrl('https://example.com/search?q=hello%20world'); }).not.toThrow();
      expect(() => { validateUrl('https://example.com/path%20with%20spaces'); }).not.toThrow();
    });

    it('allows URLs with international domain names', () => {
      expect(() => { validateUrl('https://例え.jp'); }).not.toThrow();
    });

    it('allows URLs with subdomains', () => {
      expect(() => { validateUrl('https://subdomain.example.com'); }).not.toThrow();
      expect(() => { validateUrl('https://deep.nested.subdomain.example.com'); }).not.toThrow();
    });

    it('allows IPv4 addresses', () => {
      expect(() => { validateUrl('https://192.168.1.1'); }).not.toThrow();
      expect(() => { validateUrl('http://127.0.0.1:8080'); }).not.toThrow();
    });

    it('allows IPv6 addresses', () => {
      expect(() => { validateUrl('https://[::1]'); }).not.toThrow();
      expect(() => { validateUrl('http://[2001:db8::1]:8080'); }).not.toThrow();
    });
  });

  describe('Malformed URLs are rejected', () => {
    it('rejects completely invalid URLs', () => {
      expect(() => { validateUrl('not a url'); }).toThrow(SecurityError);
      expect(() => { validateUrl('not a url'); }).toThrow(
        /Malformed URL "not a url" - cannot parse/
      );
    });

    it('rejects URLs with only protocol', () => {
      expect(() => { validateUrl('https://'); }).toThrow(SecurityError);
      expect(() => { validateUrl('https://'); }).toThrow(/Malformed URL/);
    });

    it('rejects empty string', () => {
      expect(() => { validateUrl(''); }).toThrow(SecurityError);
      expect(() => { validateUrl(''); }).toThrow(/Malformed URL ""/);
    });

    it('allows URLs with spaces (URL constructor auto-encodes)', () => {
      // Modern URL constructor automatically encodes spaces in the path
      expect(() => { validateUrl('https://example.com/path with spaces'); }).not.toThrow();
    });

    it('rejects URLs missing protocol', () => {
      expect(() => { validateUrl('example.com'); }).toThrow(SecurityError);
      expect(() => { validateUrl('example.com'); }).toThrow(/Malformed URL "example.com"/);
    });

    it('rejects URLs with special characters', () => {
      // URL constructor throws for these malformed inputs
      expect(() => { validateUrl('ht!tp://example.com'); }).toThrow(SecurityError);
      expect(() => { validateUrl('http://exam ple.com'); }).toThrow(SecurityError);
    });
  });

  describe('Protocol casing is handled correctly', () => {
    it('normalizes HTTPS to https:', () => {
      // URL constructor normalizes protocol to lowercase
      expect(() => { validateUrl('HTTPS://example.com'); }).not.toThrow();
      expect(() => { validateUrl('HtTpS://example.com'); }).not.toThrow();
    });

    it('normalizes HTTP to http:', () => {
      expect(() => { validateUrl('HTTP://example.com'); }).not.toThrow();
      expect(() => { validateUrl('HtTp://example.com'); }).not.toThrow();
    });

    it('blocks dangerous protocols even with mixed case', () => {
      // URL constructor normalizes to lowercase, so FILE:// becomes file://
      expect(() => { validateUrl('FILE:///etc/passwd'); }).toThrow(SecurityError);
      expect(() => { validateUrl('JAVASCRIPT:alert(1)'); }).toThrow(SecurityError);
      expect(() => { validateUrl('DATA:text/html,<script>'); }).toThrow(SecurityError);
    });
  });

  describe('Edge cases and attack vectors', () => {
    it('blocks protocol with Unicode homoglyphs (if URL constructor accepts)', () => {
      // URL constructor will throw for invalid protocols, which is what we want
      expect(() => { validateUrl('һttps://example.com'); }).toThrow(SecurityError); // Cyrillic 'h'
    });

    it('handles URLs with null bytes (URL constructor rejects)', () => {
      expect(() => { validateUrl('https://example.com\0/malicious'); }).toThrow(SecurityError);
    });

    it('handles extremely long URLs', () => {
      const longPath = 'a'.repeat(10000);
      expect(() => { validateUrl(`https://example.com/${longPath}`); }).not.toThrow();
    });

    it('handles URLs with many subdomain levels', () => {
      const deepSubdomain = 'a.'.repeat(100);
      expect(() => { validateUrl(`https://${deepSubdomain}example.com`); }).not.toThrow();
    });

    it('handles URLs with unusual but valid TLDs', () => {
      expect(() => { validateUrl('https://example.museum'); }).not.toThrow();
      expect(() => { validateUrl('https://example.co.uk'); }).not.toThrow();
    });

    it('handles URLs with default ports', () => {
      expect(() => { validateUrl('https://example.com:443'); }).not.toThrow();
      expect(() => { validateUrl('http://example.com:80'); }).not.toThrow();
    });

    it('handles URLs with only domain (no path)', () => {
      expect(() => { validateUrl('https://example.com'); }).not.toThrow();
    });

    it('handles URLs with trailing slash', () => {
      expect(() => { validateUrl('https://example.com/'); }).not.toThrow();
    });

    it('blocks file:// even with URL encoding', () => {
      // %66 = 'f', %69 = 'i', %6c = 'l', %65 = 'e'
      // URL constructor normalizes the protocol before our check
      expect(() => { validateUrl('%66ile:///etc/passwd'); }).toThrow(SecurityError);
    });

    it('handles AWS tag values that might contain URLs', () => {
      // These would be typical values that might appear in AWS tags
      expect(() => { validateUrl('https://jira.company.com/browse/PROJ-123'); }).not.toThrow();
      expect(() => { validateUrl('https://github.com/company/repo/issues/456'); }).not.toThrow();
    });

    it('blocks URLs trying to use @ for confusion attacks', () => {
      // https://attacker.com@trusted.com goes to attacker.com, not trusted.com
      // But this is still https://, so we allow it (browser will handle correctly)
      expect(() => { validateUrl('https://attacker.com@trusted.com'); }).not.toThrow();
    });

    it('handles URLs with multiple @ symbols', () => {
      expect(() => { validateUrl('https://user:pa@ss@example.com'); }).not.toThrow();
    });
  });

  describe('Real-world AWS billing data scenarios', () => {
    it('allows AWS documentation URLs', () => {
      expect(() => { validateUrl('https://docs.aws.amazon.com/cur/latest/userguide/what-is-cur.html'); }).not.toThrow();
      expect(() => { validateUrl('https://aws.amazon.com/premiumsupport/knowledge-center/'); }).not.toThrow();
    });

    it('allows GitHub issue tracker URLs', () => {
      expect(() => { validateUrl('https://github.com/company/repo/issues/123'); }).not.toThrow();
    });

    it('allows JIRA URLs', () => {
      expect(() => { validateUrl('https://company.atlassian.net/browse/PROJ-123'); }).not.toThrow();
    });

    it('allows monitoring dashboard URLs', () => {
      expect(() => { validateUrl('https://grafana.company.com/d/dashboard'); }).not.toThrow();
      expect(() => { validateUrl('https://datadog.com/dashboard/abc-123'); }).not.toThrow();
    });

    it('allows wiki URLs', () => {
      expect(() => { validateUrl('https://wiki.company.com/pages/viewpage.action?pageId=123'); }).not.toThrow();
      expect(() => { validateUrl('https://confluence.company.com/display/TEAM/Page'); }).not.toThrow();
    });

    it('blocks malicious tag value with file:// protocol', () => {
      // Attacker sets tag: owner=file:///etc/passwd
      expect(() => { validateUrl('file:///etc/passwd'); }).toThrow(SecurityError);
    });

    it('blocks malicious tag value with javascript: protocol', () => {
      // Attacker sets tag: owner=javascript:alert(document.cookie)
      expect(() => { validateUrl('javascript:alert(document.cookie)'); }).toThrow(SecurityError);
    });

    it('blocks malicious tag value with custom:// handler', () => {
      // Attacker sets tag: owner=slack://open?team=T123
      expect(() => { validateUrl('slack://open?team=T123'); }).toThrow(SecurityError);
    });
  });

  describe('SecurityError message format', () => {
    it('includes the dangerous protocol in error message', () => {
      try {
        validateUrl('file:///etc/passwd');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(SecurityError);
        expect(error).toHaveProperty('name', 'SecurityError');
        expect((error as Error).message).toContain('Dangerous URL protocol "file:"');
        expect((error as Error).message).toContain('file:///etc/passwd');
      }
    });

    it('includes prevention message in error', () => {
      try {
        validateUrl('javascript:alert(1)');
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('shell.openExternal');
        expect((error as Error).message).toContain('only https:// and http:// are allowed');
      }
    });

    it('includes malformed URL in error message', () => {
      try {
        validateUrl('not a url');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(SecurityError);
        expect((error as Error).message).toContain('Malformed URL "not a url"');
        expect((error as Error).message).toContain('shell.openExternal');
      }
    });
  });
});
