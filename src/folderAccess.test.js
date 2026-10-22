import { describe, it, expect } from "vitest";
import { folderClientPairs } from "./folderAccess.js";
import { billableMinutesByFolder } from "./reconcile.js";

// pginvoice_folder_clients is derived from Client Invoicing's own cards, so a consultant's
// readable entries are exactly the folders behind their clients' cards.
describe("folderClientPairs", () => {
  const source = (f) => (f === "Aus3C IRAP" ? "Australian Cyber Collaboration Centre" : null);

  it("maps every folder behind a card to its Clients-module client, keyed lower/trimmed", () => {
    const cards = [
      { profileClient: "Magain Real Estate", searchFolders: ["Magain", "Magain Sales ", "Magain Team Turner"] },
      { profileClient: "Aus 3C", searchFolders: ["Aus3C IRAP"] },
      { profileClient: null, searchFolders: ["Wine Australia"] }, // unregistered: never mapped
    ];
    expect(folderClientPairs(cards, source)).toEqual([
      { folderKey: "magain", folder: "Magain", client: "Magain Real Estate" },
      { folderKey: "magain sales", folder: "Magain Sales", client: "Magain Real Estate" },
      { folderKey: "magain team turner", folder: "Magain Team Turner", client: "Magain Real Estate" },
      // A task-prefix synthetic folder also maps its real source folder -- the only name stored in ClickUp entries.
      { folderKey: "aus3c irap", folder: "Aus3C IRAP", client: "Aus 3C" },
      { folderKey: "australian cyber collaboration centre", folder: "Australian Cyber Collaboration Centre", client: "Aus 3C" },
    ]);
  });

  it("dedupes, and keeps one folder shared by two clients as two pairs", () => {
    const cards = [
      { profileClient: "Comunet", searchFolders: ["Comunet", "comunet"] },
      { profileClient: "Comunet (HTSA project)", searchFolders: ["Comunet"] },
    ];
    expect(folderClientPairs(cards, () => null).map((p) => `${p.folderKey}|${p.client}`)).toEqual(["comunet|Comunet", "comunet|Comunet (HTSA project)"]);
  });
});

describe("billableMinutesByFolder coveredMonths", () => {
  const rows = [{ monthKey: "2026-08", folder: "A", minutes: 60, billable: true, isInternal: false }];
  it("a month with no rows is 'not covered' unless the sync says it is", () => {
    // A consultant who can't see any row in September still gets September treated as
    // covered (0 minutes), exactly like an admin -- otherwise the prior-month estimate drops.
    expect(billableMinutesByFolder(rows, "2026-09", true)).toBeNull();
    expect(billableMinutesByFolder(rows, "2026-09", true, ["2026-08", "2026-09"])).toEqual(new Map());
    expect(billableMinutesByFolder(rows, "2026-08", true, ["2026-08"]).get("a")).toBe(60);
  });
});
