import { describe, it, expect } from "vitest";
import { waMessageText, waMediaKind } from "../src/lib/wa/message-text";

const cases: Array<[string, any]> = [
  ["pollCreationMessage", { message: { pollCreationMessage: { name: "Which bike?", options: [{ optionName: "Click 125 - 250B/day" }, { optionName: "PCX 160 - 400B/day" }] } } }],
  ["pollCreationMessageV3", { message: { pollCreationMessageV3: { name: "Which bike?", options: [{ optionName: "Click 125 - 250B/day" }] } } }],
  ["catalogMessage", { message: { catalogMessage: { title: "Rainbow Rentals catalog", description: "Scooters from 200B/day" } } }],
  ["liveLocationMessage", { message: { liveLocationMessage: { degreesLatitude: 7.8, degreesLongitude: 98.3, caption: "on my way" } } }],
  ["ptvMessage", { message: { ptvMessage: { mimetype: "video/mp4" } } }],
  ["requestPaymentMessage", { message: { requestPaymentMessage: { amount: { value: 2000, currencyCode: "THB" }, noteMessage: { extendedTextMessage: { text: "deposit 2000" } } } } }],
  ["listMessage sections rows", { message: { listMessage: { title: "Menu", sections: [{ rows: [{ title: "Click 125", description: "250B/day" }, { title: "PCX", description: "400B/day" }] }] } } }],
  ["buttonsMessage buttons", { message: { buttonsMessage: { buttons: [{ buttonText: { displayText: "250B/day" } }, { buttonText: { displayText: "Not available" } }] } } }],
  ["deviceSentMessage", { message: { deviceSentMessage: { message: { conversation: "I'll handle this myself" } } } }],
  ["protocolMessage revoke", { message: { protocolMessage: { type: "REVOKE" } } }],
  ["albumMessage", { message: { albumMessage: { expectedImageCount: 3 } } }],
  ["contactsArrayMessage x3", { message: { contactsArrayMessage: { contacts: [{ displayText: "A" }, { displayText: "B" }, { displayText: "C" }] } } }],
];

describe("Evolution/Baileys message-type coverage", () => {
  it("prints the reader's verdict for each subtype", () => {
    const rows = cases.map(([name, payload]) => ({
      subtype: name,
      text: JSON.stringify(waMessageText(payload)),
      kind: JSON.stringify(waMediaKind(payload)),
      dropped: waMessageText(payload) === "" && waMediaKind(payload) === null,
    }));
    console.log(rows.map((r) => `${r.subtype.padEnd(26)} text=${r.text.padEnd(16)} kind=${r.kind.padEnd(14)} ${r.dropped ? "*** DROPPED (empty-media) ***" : ""}`).join("\n"));
    expect(rows.length).toBe(cases.length);
  });
});
