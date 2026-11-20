---
name: airtable-export
description: Extract all rows from an Airtable public shared view as JSON without an API key using Playwright browser automation
---

# Scrape Airtable Public Shared View

Scrape all rows from an Airtable public share link (no API key needed) by calling Airtable's internal `readSharedViewData` API from within a Playwright browser context.

## When to Use

- You have an Airtable public share link (URL containing `/shr` in the path)
- You need all rows exported as JSON
- No API key is available
- The view may have hundreds of rows that need robust extraction

## Prerequisites

```bash
./setup.sh
```

This installs Playwright and the Chromium browser in one command.

## Steps

### 1. Navigate to the share URL with Playwright

Use Playwright to load the share URL in a headless browser. This establishes all cookies and session state automatically.

```javascript
const { chromium } = require("playwright");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

await page.goto(SHARE_URL, {
  waitUntil: "domcontentloaded",
  timeout: 60000
});
await page.waitForTimeout(5000); // let JS hydrate the page
```

### 2. Capture the API URL via network interception

The page automatically calls `readSharedViewData` when it loads. Intercept this request to capture the full URL (which contains the access policy and signature).

The page always requests msgpack (`allowMsgpackOfResult: true`), and the server honors that parameter, so rewrite it to `false` on the captured URL to get a JSON response when replaying it. If the parameter is absent, inject it into `stringifiedObjectParams` instead.

```javascript
let sharedViewUrl = null;
page.on("request", (request) => {
  const url = request.url();
  if (url.includes("readSharedViewData")) {
    sharedViewUrl = url;
  }
});

const capturedUrl = /allowMsgpackOfResult/i.test(sharedViewUrl) ? sharedViewUrl.replace(/(%22allowMsgpackOfResult%22%3A|"allowMsgpackOfResult":)(?:true|false)/, "$1false") : sharedViewUrl.replace(/(stringifiedObjectParams=(?:%7B|\{)[^&]*?)(?:%7D|\})(?=&)/, "$1,%22allowMsgpackOfResult%22%3Afalse%7D");
```

This eliminates the need to parse HTML or hardcode access policies. The captured URL contains everything needed for the fetch.

### 3. Extract the application ID

```javascript
const appIdMatch = capturedUrl.match(/applicationId%22%3A%22(app[A-Za-z0-9]+)/);
const appId = appIdMatch ? appIdMatch[1] : "";
```

### 4. Call the internal API from within the browser

Use `page.evaluate()` to run a `fetch()` inside the browser context. This is the critical step - the request inherits all cookies and session state.

```javascript
const result = await page.evaluate(
  async ({ url, appId }) => {
    const resp = await fetch(url, {
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        "x-airtable-application-id": appId,
        "x-user-locale": "en",
        "x-airtable-inter-service-client": "webClient",
        "x-time-zone": "America/New_York"
      },
      credentials: "include"
    });

    if (!resp.ok) {
      return { error: `HTTP ${resp.status}` };
    }

    const data = await resp.json();
    return data;
  },
  { url: capturedUrl, appId }
);
```

**Critical headers** (all required):

- `x-airtable-application-id` - the app ID extracted from the captured URL
- `x-time-zone` - any valid timezone string (e.g., `America/New_York`)
- `x-airtable-inter-service-client` - must be `webClient`
- `x-user-locale` - `en`
- `X-Requested-With` - `XMLHttpRequest`
- `credentials: 'include'` - sends cookies with the request

### 5. Parse the response

The response structure is:

```
data.data.table.columns  -> array of column definitions
data.data.table.rows     -> array of row objects
```

Each column has:

- `id` - column ID (used in row cell values)
- `name` - human-readable column name
- `type` - field type (text, select, date, etc.)
- `typeOptions.choices` - for select fields, maps option IDs to names (may be array or object)

Each row has:

- `id` - record ID
- `createdTime` - creation timestamp
- `cellValuesByColumnId` - object mapping column IDs to cell values

### 6. Map cell values to column names

Build lookup maps for column IDs and select field options, then convert each row into a readable object. Preserve native JSON types (arrays, objects) instead of stringifying. Flatten rich text fields (`documentValue`) to plain text strings. Skip fields listed in `orgs.json` under `exclude_fields` for the matching app ID.

```javascript
// orgs.json: { "appXXX": { "exclude_fields": ["Attachments"] } }
const excludeFields = orgInfo.exclude_fields || [];

// Build column ID -> name map
const colMap = {};
for (const col of table.columns) {
  colMap[col.id] = col.name;
}

// Build select option ID -> name map
const selectOptions = {};
for (const col of table.columns) {
  if (col.typeOptions?.choices) {
    const choices = col.typeOptions.choices;
    if (Array.isArray(choices)) {
      choices.forEach((c) => (selectOptions[c.id] = c.name));
    } else {
      Object.keys(choices).forEach((id) => (selectOptions[id] = choices[id].name || choices[id]));
    }
  }
}

// Convert rows
const records = table.rows.map((row) => {
  const record = { _id: row.id, _createdTime: row.createdTime };
  const cells = row.cellValuesByColumnId || {};
  for (const [colId, value] of Object.entries(cells)) {
    const colName = colMap[colId] || colId;
    if (excludeFields.includes(colName)) continue;
    let val = value;

    // Resolve select field IDs to text
    if (typeof val === "string" && selectOptions[val]) {
      val = selectOptions[val];
    } else if (Array.isArray(val)) {
      val = val.map((v) => {
        if (typeof v === "string" && selectOptions[v]) return selectOptions[v];
        return v; // preserve native type
      });
    } else if (typeof val === "object" && val !== null) {
      // Flatten Airtable rich text fields to plain text
      if (val.documentValue && Array.isArray(val.documentValue)) {
        val = val.documentValue.map((seg) => seg.insert || "").join("");
      }
    }

    // Normalize date strings to date-only format
    if (typeof val === "string" && val.match(/^\d{4}-\d{2}-\d{2}T/)) {
      val = val.split("T")[0];
    }

    record[colMap[colId] || colId] = val;
  }
  return record;
});
```

### 7. Export to JSON with metadata

Write the output to a file with a `_meta` block for provenance tracking. The filename is derived from the Airtable page title.

```javascript
const pageTitle = await page.title();
const titleSlug = pageTitle
  .replace(/^Airtable - /, "")
  .replace(/[^a-zA-Z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .toLowerCase();

// orgs.json maps Airtable app IDs to org info
// { "appXXX": { "org_name": "Code The Dream", "org_abbreviation": "CTD" } }
const orgInfo = ORGS_CONFIG[appId];
const orgAbbr = orgInfo ? orgInfo.org_abbreviation.toLowerCase() : "org";
const baseName = `${orgAbbr}-${titleSlug}`;

const today = new Date().getFullYear() + "-" + String(new Date().getMonth() + 1).padStart(2, "0") + "-" + String(new Date().getDate()).padStart(2, "0");

const output = {
  _meta: {
    sourceUrl: SHARE_URL,
    pageTitle: pageTitle,
    exportedAt: today,
    rowCount: records.length,
    columnCount: Object.keys(records[0]).length
  },
  records: records
};

const jsonStr = JSON.stringify(output, null, 2);
// Collapse string arrays to one line (e.g., ["Full-Time"], ["Technology", "Consulting"])
const compactJson = jsonStr.replace(/\[\s*("(?:[^"\\]|\\.)*"(?:\s*,\s*"(?:[^"\\]|\\.)*")*)\s*\]/g, (match, inner) => {
  const items = inner.match(/"(?:[^"\\]|\\.)*"/g);
  if (items) return `[${items.join(", ")}]`;
  return match;
});
fs.writeFileSync(`objects/${baseName}.json`, compactJson + "\n");
```

## Why This Method Works

1. **No API key needed** - the public share link contains a signed access policy with an embedded signature that grants read access
2. **Dynamic access policy capture** - network interception grabs the API URL automatically, no hardcoding or HTML parsing needed
3. **No authentication headaches** - Playwright loads the real page, establishing cookies and session state. The `fetch()` call runs inside the browser, inheriting all of this
4. **All rows at once** - `readSharedViewData` returns the complete dataset, not just the visible page. No pagination needed
5. **JSON response** - setting `allowMsgpackOfResult` to `false` in the captured URL and omitting the `x-airtable-accept-msgpack` header makes the server return JSON, so no msgpack decoder is needed
6. **Select fields resolved** - the column definitions include choice mappings, so select field IDs can be converted to human-readable text
7. **Rich text flattened** - Airtable's `documentValue` rich text format is flattened to plain text strings
8. **Native type preservation** - arrays and objects keep their native JSON types instead of being stringified

## Common Pitfalls

- **Missing `x-time-zone` header** -> 400 BAD_REQUEST. Always include it.
- **Fetching from Node.js directly** -> 401 Unauthorized. Must fetch from within the browser context.
- **Msgpack response** -> replaying the captured URL unchanged returns `application/msgpack`, which `resp.json()` cannot parse. Set `allowMsgpackOfResult` to `false` first.
- **Filtering out the captured URL** -> the page's only `readSharedViewData` request now always carries `allowMsgpackOfResult`, so skipping URLs that contain it captures nothing.
- **Missing `x-airtable-application-id` header** -> 400 BAD_REQUEST. Always include it.
- **`typeOptions.choices` format** -> can be either an array or an object. Handle both.
- **Access policy signature expiry** -> the signature has an `expires` field. If it expires, re-navigate to the share URL to get a fresh one.
- **UTC vs local time** - use `getFullYear()`, `getMonth()`, `getDate()` for `exportedAt` to avoid timezone drift.

## Reference Script

A complete working script (`export.js`) is included in this repo. It supports:

- Any Airtable share URL as a CLI argument
- Multiple URLs in one run
- `--merge` flag to append only new records (by `_id`)
- `--output <dir>` flag for custom output directory
- Retry logic (3 attempts with 3s delay)
- Auto-named output files from page title
- Progress logging and summary output

Usage:

```bash
./setup.sh
node export.js [--merge] [--output <dir>] "https://airtable.com/appXXX/shrXXX/tblXXX"
```
