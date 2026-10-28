/** An element Harv saw in its last browser snapshot, by the ref number it was given. */
export interface BrowserElement {
  ref: number;
  tag: string;
  role: string;
  /** Visible text, label, aria-label, placeholder or value. */
  text: string;
  /** For inputs: their type ("password", "search", ...). */
  type: string;
  /** name / id / autocomplete of a field, which says what it's for. */
  name: string;
  /** The label of the form's submit button, when the element is in a form. */
  formSubmit: string;
}

/** The latest snapshot's elements plus the page they're on, so the safety gate can judge a click before it happens. */
export const browserRefs = { url: '', elements: new Map<number, BrowserElement>() };

export function setBrowserRefs(url: string, elements: BrowserElement[]): void {
  browserRefs.url = url;
  browserRefs.elements = new Map(elements.map((e) => [e.ref, e]));
}
