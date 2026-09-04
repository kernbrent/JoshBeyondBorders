import { describe, expect, it } from "vitest";
import adminScript from "../../admin/admin.js?raw";
import statementsScript from "../../admin/donor-statements.js?raw";
import adminPage from "../../admin/index.html?raw";

describe("Admin dialog behavior", () => {
  it("keeps every dialog open when its backdrop is clicked", () => {
    expect(adminScript).toContain("preventDialogBackdropDismissal");
    expect(adminScript).toContain("event.stopImmediatePropagation()");
    expect(adminPage).toContain('closedby="closerequest"');
    expect(statementsScript).not.toContain("event.target === noteDialog");
  });
});