import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { harvBrowser, harvBrowserTab } from '../tools/harvBrowser.ts';
import { text } from './memory.ts';

// Harv's hands in the browser tab. Every call passes the safety gate first
// (safety/browser.ts): looking is green, anything that could send, buy, post or
// delete is red and waits for the user's approval.

const run = async (action: (id: string) => Promise<string>) => {
  try {
    return text(await action(await harvBrowserTab()));
  } catch (err) {
    return { ...text(`Browser error: ${(err as Error).message}`), isError: true };
  }
};

export const browserTools = [
  tool(
    'browser_open',
    "Open a web page in the browser tab (the user's Chrome, shown live in the dashboard so they can watch). Accepts a URL or search words (searched on Google). Then use browser_snapshot to see the page.",
    { url: z.string().min(1).describe('A URL, or words to search for') },
    async ({ url }) => run((id) => harvBrowser().goTo(id, url)),
  ),
  tool(
    'browser_snapshot',
    "See the current browser page: its title, URL, the clickable/typeable elements as numbered refs, and its text. Take a new snapshot after anything changes the page; refs from older snapshots don't work.",
    {},
    async () => run((id) => harvBrowser().snapshot(id)),
  ),
  tool(
    'browser_click',
    'Click an element from the latest snapshot by its ref number. Clicking something that sends, buys, posts, deletes or signs up asks the user first.',
    { ref: z.number().int().min(1).describe('The element’s number from browser_snapshot') },
    async ({ ref }) => run((id) => harvBrowser().click(id, ref)),
  ),
  tool(
    'browser_type',
    'Type into a field from the latest snapshot (replacing what is there). submit: true presses Enter afterwards, e.g. for a search box. Password and payment fields always ask the user first.',
    {
      ref: z.number().int().min(1).describe('The field’s number from browser_snapshot'),
      text: z.string().describe('What to type'),
      submit: z.boolean().optional().describe('Press Enter afterwards'),
    },
    async ({ ref, text: value, submit }) => run((id) => harvBrowser().type(id, ref, value, submit === true)),
  ),
  tool(
    'browser_press',
    'Press a key in the browser page: Escape, Tab, ArrowDown, PageDown… (Enter asks the user first, since it can submit a form).',
    { key: z.string().min(1).describe('A key name like Escape, Tab, ArrowDown, Enter') },
    async ({ key }) => run((id) => harvBrowser().press(id, key)),
  ),
  tool(
    'browser_scroll',
    'Scroll the browser page up or down by most of a screen.',
    { direction: z.enum(['up', 'down']) },
    async ({ direction }) => run((id) => harvBrowser().scroll(id, direction)),
  ),
  tool('browser_back', 'Go back to the previous page in the browser tab.', {}, async () => run((id) => harvBrowser().goBack(id))),
  tool(
    'browser_screenshot',
    'A picture of what the browser tab shows right now, when the text snapshot isn’t enough (layouts, images, charts). Costs more of the plan than a snapshot.',
    {},
    async () => {
      try {
        const data = await harvBrowser().screenshot(await harvBrowserTab());
        return { content: [{ type: 'image' as const, data, mimeType: 'image/jpeg' }] };
      } catch (err) {
        return { ...text(`Browser error: ${(err as Error).message}`), isError: true };
      }
    },
  ),
];
