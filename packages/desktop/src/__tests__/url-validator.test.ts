import { describe, it, expect } from 'vitest';
import { validateUrl, SecurityError } from '../main/url-validator.js';

describe('validateUrl', () => {
  it('allows https and http URLs', () => {
    expect(() => { validateUrl('https://example.com'); }).not.toThrow();
    expect(() => { validateUrl('http://localhost:3000'); }).not.toThrow();
    expect(() => { validateUrl('https://docs.aws.amazon.com/cur/latest/userguide/'); }).not.toThrow();
  });

  it('blocks dangerous protocols', () => {
    expect(() => { validateUrl('file:///etc/passwd'); }).toThrow(SecurityError);
    expect(() => { validateUrl('javascript:alert(1)'); }).toThrow(SecurityError);
    expect(() => { validateUrl('data:text/html,<script>alert(1)</script>'); }).toThrow(SecurityError);
    expect(() => { validateUrl('smb://evil.com/share'); }).toThrow(SecurityError);
  });

  it('blocks arbitrary custom protocols', () => {
    expect(() => { validateUrl('slack://channel?id=123'); }).toThrow(SecurityError);
    expect(() => { validateUrl('vscode://file/path'); }).toThrow(SecurityError);
  });

  it('rejects malformed URLs', () => {
    expect(() => { validateUrl('not a url'); }).toThrow(SecurityError);
    expect(() => { validateUrl(''); }).toThrow(SecurityError);
    expect(() => { validateUrl('example.com'); }).toThrow(SecurityError);
  });

  it('normalizes protocol casing', () => {
    expect(() => { validateUrl('HTTPS://example.com'); }).not.toThrow();
    expect(() => { validateUrl('FILE:///etc/passwd'); }).toThrow(SecurityError);
  });
});
