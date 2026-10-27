import { describe, it, expect } from "vitest";
import { parseBulkLine, parseBulkUsers, rosterMatchFor } from "./bulkUsers.js";

const clickupNames = ["Holly Latham", "Holly Fraser", "Kasey Doran", "Chloe James"];
const roster = [{ id: "p1", name: "Holly L" }, { id: "p2", name: "Holly Fraser" }, { id: "p3", name: "Kasey" }, { id: "p4", name: "Chloe" }, { id: "p5", name: "Chloe" }];

describe("parseBulkLine", () => {
  it("finds the email anywhere and keeps the rest as the name", () => {
    expect(parseBulkLine("Holly@PG.com.au, Holly Latham")).toEqual({ email: "holly@pg.com.au", name: "Holly Latham" });
    expect(parseBulkLine("Holly Latham <holly@pg.com.au>")).toEqual({ email: "holly@pg.com.au", name: "Holly Latham" });
    expect(parseBulkLine("holly@pg.com.au\tHolly  Latham")).toEqual({ email: "holly@pg.com.au", name: "Holly Latham" });
    expect(parseBulkLine("Holly Latham")).toEqual({ email: "", name: "Holly Latham" });
  });
});

describe("rosterMatchFor", () => {
  it("exact name, else a unique first name with a matching surname initial", () => {
    expect(rosterMatchFor("Holly Fraser", roster).id).toBe("p2");
    expect(rosterMatchFor("Holly Latham", roster).id).toBe("p1");
    expect(rosterMatchFor("Kasey Doran", roster).id).toBe("p3");
  });
  it("ambiguous or already linked: none", () => {
    expect(rosterMatchFor("Chloe James", roster)).toBeNull();
    expect(rosterMatchFor("Kasey Doran", roster, ["p3"])).toBeNull();
  });
});

describe("parseBulkUsers", () => {
  const opts = { existingEmails: ["kelly@pg.com.au"], clickupNames, roster };
  it("canonical ClickUp spelling, roster person, problems per line", () => {
    const rows = parseBulkUsers("holly@pg.com.au, holly latham\n\nkelly@pg.com.au, Chloe James\nholly@pg.com.au, Holly Latham\nx@pg.com.au, Nobody\ny@pg.com.au", opts);
    expect(rows.map((r) => r.line)).toEqual([1, 3, 4, 5, 6]);
    expect(rows[0]).toMatchObject({ email: "holly@pg.com.au", clickupUserName: "Holly Latham", problems: [] });
    expect(rows[0].person.id).toBe("p1");
    expect(rows[1].problems).toEqual(["Already has an account"]);
    expect(rows[2].problems).toEqual(["Listed twice (also line 1)"]);
    expect(rows[3].problems).toEqual(['"Nobody" isn\'t a ClickUp user']);
    expect(rows[4].problems).toEqual(["Add their ClickUp name after the email"]);
  });
  it("one roster person is never matched to two rows; admins need no ClickUp name", () => {
    const rows = parseBulkUsers("a@pg.com.au, Holly Latham\nb@pg.com.au", { ...opts, roster: [{ id: "p1", name: "Holly" }], clickupRequired: false });
    expect(rows[0].person.id).toBe("p1");
    expect(rows[1].problems).toEqual([]);
  });
});
