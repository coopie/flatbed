# The fetch_page tool

`fetch_page` is the press office's one way to see the world. It reads one public web page through the playground's `/api/fetch`, saves the page's text as a document in `sources/`, and gives the same text back to the agent. The app provides it; this template names it in `template.json`'s `tools`. This page is the contract for whoever builds it.

Two things shape it. The supervisor checks every draft against the pages it can see in the session, so the tool returns the saved text in full rather than a summary. And every page the agent reads is re-sent on each later model call in that session, so a page's saved text stops at about 8,000 tokens.

## Input

```json
{
  "name": "fetch_page",
  "description": "Read one public web page and save its text in sources/. Returns the saved text and the links on the page. Aim for about six pages per company: the home page, about, a product page and the blog or news page.",
  "input_schema": {
    "type": "object",
    "properties": {
      "url": { "type": "string", "description": "The full address, such as https://example.com/about" }
    },
    "required": ["url"]
  }
}
```

Before fetching, the tool normalises the address: it adds `https://` when there is no scheme, lowercases the host, and drops any `#fragment`. Any public page is allowed, not only the company's own site, since a news article about the company is fair evidence too. `/api/fetch` enforces http and https only, public addresses only, a size cap and a short cache, as `docs/playground.md` says.

## What it saves

One document per page, in the document store, through the host rather than the agent's tools, since `sources/` is a `read` folder.

- **Name**: `sources/` then a slug of the host without `www.`, then the path, with every run of characters other than `a-z` and `0-9` turned into one dash and the ends trimmed. The root path is `home`. So `https://www.quillfern.example/about-us/` becomes `sources/quillfern-example-about-us`, and `https://quillfern.example/` becomes `sources/quillfern-example-home`. Cut a name to 80 characters. The query string is ignored, so two addresses that differ only by it share a document.
- **Summary**: the page's `<title>`, then ` | ` and its meta description when it has one, on one line, cut to 160 characters. When the page has neither, use the first 160 characters of its text.
- **Body**: two lines of provenance, a blank line, then the page's text as plain Markdown:

  ```
  Source: https://quillfern.example/about-us
  Fetched: 2026-10-19

  # About Quillfern

  Quillfern makes scheduling software for dental clinics...
  ```

  Keep headings as Markdown headings, paragraphs and list items as they are, and link text without the address. Leave out scripts, styles, navigation, headers, footers, cookie banners and forms where the HTML marks them (`<nav>`, `<header>`, `<footer>`, `<form>`, `<script>`, `<style>`, `aria-hidden`); prefer `<main>` or `<article>` when the page has one. When the text runs past 32,000 characters, about 8,000 tokens, cut it at the last paragraph break before that and end the body with `[The rest of the page was not saved.]`.

Fetching an address that already has a document writes a new version of it, which the document store keeps alongside the old one.

## What it returns to the agent

A successful result is the document as `read_doc` would show it, so the supervisor reads both the same way, followed by the links on the page:

```
Saved sources/quillfern-example-about-us (4,120 words).

<doc name="sources/quillfern-example-about-us" summary="About Quillfern | Scheduling for dental clinics">
Source: https://quillfern.example/about-us
...
</doc>

Links on this page:
- Pricing: https://quillfern.example/pricing
- Blog: https://quillfern.example/blog
```

List up to 30 links, on the same host first, with their text, leaving out duplicates, links to the page itself, `mailto:` and links to files such as PDFs and images. The links are in the result only, not in the saved document, because they help the agent choose its next page but are not evidence for a draft.

## When a page cannot be fetched

A failure is a normal tool result, not an error that stops the run, and nothing is saved. Each one says in a sentence what happened and what to try, so the agent can move on:

| Case | Result |
| --- | --- |
| Not a web address, or not http or https | `That is not a web address. Give a full address, such as https://example.com/about.` |
| A private or local address | `That address is not public, so it cannot be fetched. Try a page on the company's public site.` |
| 404 or 410 | `There is no page at https://... (404). Pick a link from a page you have already fetched.` |
| 401 or 403 | `The site would not show https://... to the playground (403). Try another page.` |
| Other 4xx, 5xx, or a network failure | `https://... could not be fetched (503). Try again later, or try another page.` |
| Timed out | `https://... took too long to answer. Try another page.` |
| Not HTML or plain text, such as a PDF or an image | `https://... is a PDF, not a web page, so it was not saved. Try the page that links to it.` |
| Fewer than 200 characters of text after cleaning | `https://... has almost no text without JavaScript, so it was not saved. Try the about or blog page, which are often plain HTML.` |
| The playground is read-only for the day | `The playground has used today's budget, so no more pages can be fetched today.` |

A redirect is followed, and the document is named after the address it ends at. The result then says so: `https://quillfern.example/ redirected to https://www.quillfern.example/en/.`
