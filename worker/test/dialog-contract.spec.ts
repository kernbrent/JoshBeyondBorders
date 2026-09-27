import { describe, expect, it } from "vitest";
import adminScript from "../../admin/admin.js?raw";
import statementsScript from "../../admin/donor-statements.js?raw";
import contactsScript from "../../admin/contacts.js?raw";
import adminPage from "../../admin/index.html?raw";

describe("Admin dialog behavior", () => {
  it("keeps every dialog open when its backdrop is clicked", () => {
    expect(adminScript).toContain("preventDialogBackdropDismissal");
    expect(adminScript).toContain("event.stopImmediatePropagation()");
    expect(adminPage).toContain('closedby="closerequest"');
    expect(statementsScript).not.toContain("event.target === noteDialog");
  });

  it("keeps the protected contact directory tied to existing donor records", () => {
    expect(adminPage).toContain('id="open-contacts"');
    expect(adminPage).toContain('id="contacts-panel"');
    expect(adminPage).toContain('src="contacts.js?v=');
    expect(adminScript).toContain("JBBContacts.open");
    expect(adminScript).toContain("openGivingStatements: showDonorStatements");
    expect(contactsScript).toContain("/api/admin/contacts/list");
    expect(adminPage).toContain("Create giving statements");
  });
});
