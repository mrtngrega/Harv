import { describe, expect, it } from 'vitest';
import { fileOfUrl, toBrowserUrl } from './browser.ts';

describe('the browser’s address bar', () => {
  it('opens web addresses, local pages and files', () => {
    expect(toBrowserUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(toBrowserUrl('example.com')).toBe('https://example.com');
    expect(toBrowserUrl('localhost:5173')).toBe('http://localhost:5173');
    expect(toBrowserUrl('C:\\My files\\Code\\car_radio\\design\\mockup.html')).toBe(
      'file:///C:/My%20files/Code/car_radio/design/mockup.html',
    );
    expect(toBrowserUrl('/home/me/Code/car_radio/design/mockup.html')).toBe('file:///home/me/Code/car_radio/design/mockup.html');
    expect(toBrowserUrl('~/Code/x.html', '/home/me')).toBe('file:///home/me/Code/x.html');
  });

  it('searches Google for anything else', () => {
    expect(toBrowserUrl('weather Bratislava')).toBe('https://www.google.com/search?q=weather%20Bratislava');
  });

  it('knows the file behind a file address, to reload it when it changes', () => {
    expect(fileOfUrl('file:///C:/My%20files/Code/x.html')).toBe('C:\\My files\\Code\\x.html');
    expect(fileOfUrl('file:///home/me/x.html')).toBe('/home/me/x.html');
    expect(fileOfUrl('https://example.com')).toBeNull();
  });
});
