const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const MERGE_MODE = args.includes("--merge");
const OUTPUT_FLAG_IDX = args.indexOf("--output");
const OUTPUT_DIR = OUTPUT_FLAG_IDX !== -1 && args[OUTPUT_FLAG_IDX + 1] ? path.resolve(args[OUTPUT_FLAG_IDX + 1]) : path.join(__dirname, "objects");
const SHARE_URLS = args.filter((a) => !a.startsWith("--") && a !== (OUTPUT_FLAG_IDX !== -1 ? args[OUTPUT_FLAG_IDX + 1] : ""));
const MAX_RETRIES = 3;
const ORGS_CONFIG_PATH = path.join(__dirname, "orgs.json");
let ORGS_CONFIG = {};
if (fs.existsSync(ORGS_CONFIG_PATH)) {
  ORGS_CONFIG = JSON.parse(fs.readFileSync(ORGS_CONFIG_PATH, "utf8"));
}

if (SHARE_URLS.length === 0) {
  console.error("Usage: node export.js [--merge] [--output <dir>] <url1> [url2] ...");
  console.error("Example: node export.js https://airtable.com/appXXX/shrXXX/tblXXX");
  console.error("  --merge   Append new records to existing output file (by _id)");
  console.error("  --output  Specify output directory (default: ./objects)");
  process.exit(1);
}

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exportOneTable(browser, shareUrl, attempt = 1) {
  const context = await browser.newContext();
  const page = await context.newPage();

  let capturedUrl = null;
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("readSharedViewData") && !url.includes("allowMsgpackOfResult")) {
      capturedUrl = url;
    }
  });

  try {
    console.log(`[${attempt}/${MAX_RETRIES}] Navigating to ${shareUrl}...`);
    await page.goto(shareUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });
    await page.waitForTimeout(5000);

    if (!capturedUrl) {
      throw new Error("Failed to capture readSharedViewData request URL");
    }

    console.log("Captured API URL with access policy");

    const appIdMatch = capturedUrl.match(/applicationId%22%3A%22(app[A-Za-z0-9]+)/);
    const appId = appIdMatch ? appIdMatch[1] : "";

    const orgInfo = ORGS_CONFIG[appId] || {};
    const excludeFields = orgInfo.exclude_fields || [];

    console.log("Fetching data via internal API...");
    const result = await page.evaluate(
      async ({ url, appId, excludeFields }) => {
        const resp = await fetch(url, {
          headers: {
            "X-Requested-With": "XMLHttpRequest",
            "x-airtable-application-id": appId,
            "x-airtable-accept-msgpack": "true",
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
        const table = data.data.table;

        // Build column ID -> name map
        const colMap = {};
        for (const col of table.columns) {
          colMap[col.id] = col.name;
        }

        // Build select option ID -> name map
        const selectOptions = {};
        for (const col of table.columns) {
          if (col.typeOptions && col.typeOptions.choices) {
            const choices = col.typeOptions.choices;
            if (Array.isArray(choices)) {
              for (const choice of choices) {
                selectOptions[choice.id] = choice.name;
              }
            } else if (typeof choices === "object") {
              for (const choiceId of Object.keys(choices)) {
                const choice = choices[choiceId];
                selectOptions[choiceId] = choice.name || choice;
              }
            }
          }
        }

        // Convert rows to objects with column names
        const records = [];
        const totalRows = table.rows.length;
        for (let i = 0; i < totalRows; i++) {
          const row = table.rows[i];
          const record = { _id: row.id, _createdTime: row.createdTime };
          const cells = row.cellValuesByColumnId || {};
          for (const colId of Object.keys(cells)) {
            const colName = colMap[colId] || colId;
            if (excludeFields.includes(colName)) continue;
            let value = cells[colId];

            if (typeof value === "string" && selectOptions[value]) {
              value = selectOptions[value];
            } else if (Array.isArray(value)) {
              value = value.map((v) => {
                if (typeof v === "string" && selectOptions[v]) return selectOptions[v];
                if (typeof v === "object" && v !== null) return v;
                return v;
              });
            } else if (typeof value === "object" && value !== null) {
              // Flatten Airtable rich text fields to plain text
              if (value.documentValue && Array.isArray(value.documentValue)) {
                value = value.documentValue.map((seg) => seg.insert || "").join("");
              }
            }

            // Only normalize date strings to date-only format
            if (typeof value === "string" && value.match(/^\d{4}-\d{2}-\d{2}T/)) {
              value = value.split("T")[0];
            }

            record[colName] = value;
          }
          records.push(record);
        }

        return { records, totalRows };
      },
      { url: capturedUrl, appId, excludeFields }
    );

    if (result.error) {
      throw new Error(`API returned ${result.error}`);
    }

    const { records, totalRows } = result;
    console.log(`Parsed ${totalRows} rows...`);
    console.log(`Extracted ${records.length} records with ${Object.keys(records[0]).length} columns`);

    // Derive output filename from page title + org config
    // Format: "Airtable - <BaseName> - <TableName>" -> "<org-abbr>-<base-name>-<table-name>"
    // Org abbreviation comes from orgs.json (mapped by applicationId)
    const pageTitle = await page.title();
    const titleSlug = pageTitle
      .replace(/^Airtable - /, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
    const orgAbbr = orgInfo.org_abbreviation ? orgInfo.org_abbreviation.toLowerCase() : "org";
    const baseName = orgInfo.output_name || `${orgAbbr}-${titleSlug}`;

    let finalRecords = records;
    let newCount = records.length;

    if (MERGE_MODE) {
      // Find existing file matching this table (by sourceUrl in _meta)
      const existingFiles = fs.readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".json"));

      let existingPath = null;
      let existingData = null;
      for (const file of existingFiles) {
        const filePath = path.join(OUTPUT_DIR, file);
        const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (content._meta && content._meta.sourceUrl === shareUrl) {
          existingPath = filePath;
          existingData = content;
          break;
        }
      }

      if (existingData) {
        const existingIds = new Set(existingData.records.map((r) => r._id));
        const newRecords = records.filter((r) => !existingIds.has(r._id));
        finalRecords = [...existingData.records, ...newRecords];
        newCount = newRecords.length;
        console.log(`Merge: ${existingData.records.length} existing + ${newCount} new = ${finalRecords.length} total`);
        if (existingPath) {
          fs.unlinkSync(existingPath);
        }
      } else {
        console.log("No existing file found, creating new output");
      }
    }

    const outputName = baseName;

    // Save JSON with metadata
    const outputPath = {
      _meta: {
        sourceUrl: shareUrl,
        pageTitle: pageTitle,
        exportedAt: new Date().getFullYear() + "-" + String(new Date().getMonth() + 1).padStart(2, "0") + "-" + String(new Date().getDate()).padStart(2, "0"),
        rowCount: finalRecords.length,
        columnCount: Object.keys(finalRecords[0]).length
      },
      records: finalRecords
    };
    const jsonPath = path.join(OUTPUT_DIR, `${outputName}.json`);
    const jsonStr = JSON.stringify(outputPath, null, 2);
    const compactJson = jsonStr.replace(/\[\s*("(?:[^"\\]|\\.)*"(?:\s*,\s*"(?:[^"\\]|\\.)*")*)\s*\]/g, (match, inner) => {
      const items = inner.match(/"(?:[^"\\]|\\.)*"/g);
      if (items) return `[${items.join(", ")}]`;
      return match;
    });
    fs.writeFileSync(jsonPath, compactJson + "\n");
    console.log(`JSON saved to: ${jsonPath}`);

    await context.close();
    return {
      success: true,
      url: shareUrl,
      count: finalRecords.length,
      newCount
    };
  } catch (err) {
    await context.close();
    if (attempt < MAX_RETRIES) {
      console.error(`Attempt ${attempt} failed: ${err.message}`);
      console.log(`Retrying in 3s...`);
      await sleep(3000);
      return exportOneTable(browser, shareUrl, attempt + 1);
    }
    return { success: false, url: shareUrl, error: err.message };
  }
}

async function main() {
  console.log(`Exporting ${SHARE_URLS.length} table(s)...\n`);
  const browser = await chromium.launch({ headless: true });

  const results = [];
  for (const url of SHARE_URLS) {
    const result = await exportOneTable(browser, url);
    results.push(result);
    console.log("");
  }

  await browser.close();

  // Summary
  console.log("=== Summary ===");
  for (const r of results) {
    if (r.success) {
      const newInfo = r.newCount !== undefined ? ` (${r.newCount} new)` : "";
      console.log(`  OK   ${r.url} -> ${r.count} records${newInfo}`);
    } else {
      console.log(`  FAIL ${r.url} -> ${r.error}`);
    }
  }

  const failed = results.filter((r) => !r.success);
  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
