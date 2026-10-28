import type { Tier } from '@harv/shared';
import { browserRefs, type BrowserElement } from '../tools/browserRefs.ts';

// Harv's browser tools, judged like any other action. Looking around is green.
// Anything that could send, buy, post, delete or sign up for something on the
// user's behalf is red (with cards off it runs, logged). Sending to someone the
// user didn't ask to send to always asks (browserSends, persona rule 12). Unknown is red.

export const BROWSER_TOOLS = [
  'mcp__harv__browser_open',
  'mcp__harv__browser_snapshot',
  'mcp__harv__browser_click',
  'mcp__harv__browser_type',
  'mcp__harv__browser_press',
  'mcp__harv__browser_scroll',
  'mcp__harv__browser_back',
];

/** Words on a button or link that commit to something. */
const COMMITS =
  /\b(send|submit|post|publish|tweet|reply|comment|share|buy|purchase|order|checkout|check out|pay|payment|subscribe|donate|delete|remove|erase|confirm|transfer|book|reserve|sign ?up|register|create account|unsubscribe|install|upload|accept|agree|apply|save changes|place|odosla|odoslať|kúpiť|zaplatiť|objednať|zmazať|potvrdiť)\b/i;
/** The ones that send something to someone (the sending check). */
const SENDS = /\b(send|post|publish|tweet|reply|comment|share|message|odosla|odoslať|poslať|zdieľať)\b/i;
/** Fields for secrets or money. */
const SECRET_FIELD = /(pass(word)?|pwd|otp|2fa|one-time|pin|card|cc-|cvc|cvv|iban|account.?number|security.?code|ssn|tax.?id)/i;
const SEARCH_FIELD = /(^|\b)(q|query|search|s|keywords?)($|\b)/i;

const host = (url: string) => {
  try {
    return new URL(url).hostname || 'a local file';
  } catch {
    return 'the page';
  }
};

export interface BrowserVerdict {
  tier: Tier;
  reason: string;
  summary: string;
}

const describe = (el: BrowserElement) => `${el.role || el.tag}${el.text ? ` "${el.text.slice(0, 60)}"` : ''}`;
const elementOf = (input: Record<string, unknown>) => {
  const ref = Number(input.ref);
  return Number.isFinite(ref) ? browserRefs.elements.get(ref) : undefined;
};
const isSearch = (el: BrowserElement) => el.type === 'search' || el.role === 'searchbox' || SEARCH_FIELD.test(el.name);

export function classifyBrowser(tool: string, input: Record<string, unknown>): BrowserVerdict {
  const name = tool.replace('mcp__harv__browser_', '');
  const site = host(browserRefs.url);
  const el = elementOf(input);

  switch (name) {
    case 'open': {
      const url = typeof input.url === 'string' ? input.url : '';
      return { tier: 'green', reason: 'Opening a web page or file only looks.', summary: `open ${url}` };
    }
    case 'snapshot':
    case 'scroll':
    case 'back':
      return { tier: 'green', reason: 'Looking at the page changes nothing.', summary: `${name} on ${site}` };
    case 'press': {
      const key = typeof input.key === 'string' ? input.key : '';
      if (/^(enter|return)$/i.test(key)) {
        return { tier: 'red', reason: 'Enter can submit a form (send, post, buy…).', summary: `press Enter on ${site}` };
      }
      return { tier: 'green', reason: 'A navigation key.', summary: `press ${key} on ${site}` };
    }
    case 'click': {
      if (!el)
        return { tier: 'red', reason: 'Harv can’t tell what this click does.', summary: `click element ${String(input.ref)} on ${site}` };
      const label = `${el.text} ${el.name}`;
      if (COMMITS.test(label) || (el.type === 'submit' && COMMITS.test(el.formSubmit))) {
        return {
          tier: 'red',
          reason: 'This button could send, buy, post, delete or sign you up for something.',
          summary: `click ${describe(el)} on ${site}`,
        };
      }
      return { tier: 'green', reason: 'A link or control that doesn’t commit to anything.', summary: `click ${describe(el)} on ${site}` };
    }
    case 'type': {
      if (!el)
        return {
          tier: 'red',
          reason: 'Harv can’t tell which field this is.',
          summary: `type into element ${String(input.ref)} on ${site}`,
        };
      const what = `${el.type} ${el.name} ${el.text}`;
      if (el.type === 'password' || SECRET_FIELD.test(what)) {
        return { tier: 'red', reason: 'This is a password, code or payment field.', summary: `type into ${describe(el)} on ${site}` };
      }
      const submit = input.submit === true;
      if (submit && !isSearch(el) && (el.tag === 'textarea' || el.role === 'textbox' || COMMITS.test(el.formSubmit))) {
        return {
          tier: 'red',
          reason: 'Typing and submitting here could send or post something.',
          summary: `type and submit in ${describe(el)} on ${site}`,
        };
      }
      return {
        tier: 'green',
        reason: isSearch(el) ? 'A search.' : 'Typing without sending anything.',
        summary: `type into ${describe(el)} on ${site}`,
      };
    }
    default:
      return { tier: 'red', reason: 'Unknown browser action.', summary: name };
  }
}

/** A browser action that sends something to someone: a Send/Post/Reply button, or a message box submitted. */
export function browserSends(tool: string, input: Record<string, unknown>): boolean {
  const name = tool.replace('mcp__harv__browser_', '');
  const el = elementOf(input);
  if (name === 'click') return !!el && (SENDS.test(`${el.text} ${el.name}`) || (el.type === 'submit' && SENDS.test(el.formSubmit)));
  if (name === 'type' && input.submit === true) {
    return !!el && !isSearch(el) && (el.tag === 'textarea' || el.role === 'textbox' || SENDS.test(el.formSubmit));
  }
  return false;
}
