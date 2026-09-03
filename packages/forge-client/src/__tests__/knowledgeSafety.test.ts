import { describe, expect, it } from "vitest";
import { checkKnowledgeEntrySafety, checkKnowledgeSafety, describeViolation } from "../knowledgeSafety.js";

/**
 * Pure unit tests — no database, no network, no model.
 *
 * These are the tests that hold the line the user drew: the assistant may be a user guide, and
 * must never expose code, database design, or anything that could harm the project. Two things are
 * being pinned, and both matter equally:
 *
 *  1. Everything in the forbidden classes is caught.
 *  2. Ordinary support English is NOT caught — a gate that fires on legitimate answers gets
 *     ignored by reviewers, and an ignored gate protects nothing.
 */

const expectBlocked = (text: string, rule?: string) => {
  const verdict = checkKnowledgeSafety(text);
  expect(verdict.safe, `expected to be blocked: ${text}`).toBe(false);
  if (rule) expect(verdict.violations).toContain(rule);
};

const expectAllowed = (text: string) => {
  const verdict = checkKnowledgeSafety(text);
  expect(verdict.safe, `expected to be allowed but hit ${verdict.violations.join(", ")}: ${text}`).toBe(true);
};

describe("credentials and access", () => {
  it("blocks a connection string", () => {
    expectBlocked("Server=10.0.0.4;Initial Catalog=ispdigital;User Id=sa;Password=hunter2", "connection-string");
  });

  it("blocks an api key or token assignment", () => {
    expectBlocked("Set api_key: sk-or-v1-abcdef to authenticate.", "credential-literal");
    expectBlocked("password = SomethingSecret", "credential-literal");
  });

  it("blocks a private key block", () => {
    expectBlocked("-----BEGIN RSA PRIVATE KEY-----\nMIIEow==", "private-key");
  });

  it("blocks a bearer token", () => {
    expectBlocked("Authorization: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abc", "jwt");
  });

  it("blocks an internal IP address", () => {
    expectBlocked("The service runs on 192.168.10.14 inside the datacentre.", "private-address");
    expectBlocked("Point the router at 10.20.30.40.", "private-address");
  });

  it("does not block a public support phone number or ordinary digits", () => {
    expectAllowed("Call +8801896218186 or quote invoice 2026-04-01187 when you contact support.");
  });
});

describe("database design", () => {
  it("blocks SQL", () => {
    expectBlocked("SELECT InvoiceNo FROM MonthlyInvoice WHERE Status = 'Void'", "sql-statement");
    expectBlocked("CREATE TABLE Payments (Id INT)", "sql-statement");
    expectBlocked("You would INNER JOIN the customer records.", "sql-statement");
  });

  it("blocks talking about the schema in words", () => {
    expectBlocked("Each invoice has a foreign key to the customer.", "schema-vocabulary");
    expectBlocked("This is stored in a database table.", "schema-vocabulary");
    expectBlocked("A stored procedure recalculates the balance.", "schema-vocabulary");
  });

  it("blocks naming a physical table", () => {
    // The repository's own customer-facing manual does exactly this, which is why it is a rule.
    expectBlocked("Cumulative billing keeps one rolling balance in the BillMaster table.", "table-reference");
    expectBlocked("Records live in tbl_customer.", "table-reference");
  });

  it("allows the same idea said the way a customer would hear it", () => {
    expectAllowed(
      "In Cumulative billing your account keeps a single running balance. In Monthly billing you " +
        "get one invoice for each month, and each invoice has its own status.",
    );
  });
});

describe("source code and repository internals", () => {
  it("blocks a code block", () => {
    expectBlocked("Run this:\n```csharp\nvar x = 1;\n```", "code-fence");
  });

  it("blocks bare code syntax", () => {
    expectBlocked("public class BillingService", "code-syntax");
    expectBlocked("namespace ISPDIGITAL.Web.Controllers", "code-syntax");
    expectBlocked("var invoice = new MonthlyInvoice();", "code-syntax");
  });

  it("blocks a source path or code directory", () => {
    expectBlocked("See BillingController.cs for the logic.", "source-path");
    expectBlocked("It lives under ISPDIGITAL.Web/Controllers/ in the repo.", "source-path");
  });

  it("blocks naming an internal class", () => {
    expectBlocked("The BillingController handles this.", "dotnet-type");
    expectBlocked("Handled by the CustomerRepository.", "dotnet-type");
  });

  it("blocks a stack trace", () => {
    expectBlocked("System.NullReferenceException was thrown", "stack-trace");
  });

  it("blocks an internal endpoint", () => {
    expectBlocked("Call POST /api/v1/billing/generate to do this.", "internal-endpoint");
  });

  it("blocks naming internal infrastructure", () => {
    expectBlocked("A Hangfire job runs this every night.", "infrastructure");
    expectBlocked("Messages go through RabbitMQ.", "infrastructure");
  });

  it("allows the customer-facing version of an infrastructure fact", () => {
    expectAllowed("Invoices are generated automatically every night, so you do not need to do anything.");
  });
});

describe("ordinary support answers are not blocked", () => {
  const realistic = [
    "To generate this month's invoices, open Billing then Invoice List and choose Generate Invoices. Pick the period and confirm.",
    "A voided invoice stays visible so your records stay complete, but it no longer counts towards the customer's due amount.",
    "If a payment was received twice, raise a Credit Note for the extra amount. The credit is applied to the customer's next invoice automatically.",
    "PPPoE is the method your router uses to sign in to the internet connection with a username and password.",
    "Go to Customers, search by phone number, then open the customer and select Change Package.",
    "Your connection can be suspended automatically when a bill stays unpaid past its due date. Paying it restores the service.",
    "The Period Summary report shows how much was invoiced, how much was collected, and what is still outstanding for a month.",
    "You can export the list to Excel using the Export button at the top right of the table.",
    "Sorry, I do not have that information. Someone from the support team will reply shortly.",
    "Prepaid customers pay before the month starts; postpaid customers are invoiced at the end of the period.",
  ];

  for (const text of realistic) {
    it(`allows: ${text.slice(0, 52)}…`, () => expectAllowed(text));
  }
});

describe("internal identifiers — the leaks the first live run actually produced", () => {
  // Both of these were generated, stored and auto-verified by a real sync against the real
  // ISPDIGITAL manual before this rule existed. They are the reason it does.
  it("blocks the entity names the billing manual introduces as key terms", () => {
    expectBlocked(
      "The key terms are: BillPeriod, which is a calendar month; MonthlyInvoice, which is the " +
        "invoice issued for that month; and CustomerCredit, which is money on account.",
      "internal-identifier",
    );
  });

  it("blocks an internal record named in a migration answer", () => {
    expectBlocked(
      "This will create a CustomerBillMaster for each customer and switch the billing mode back to Cumulative.",
      "internal-identifier",
    );
  });

  it("does not block product and vendor names a customer already sees", () => {
    expectAllowed("Your MikroTik router uses PPPoE to sign in with a username and password.");
    expectAllowed("You can pay through bKash, Nagad or BanglaQR.");
    expectAllowed("ISPDIGITAL covers billing, customer management and network monitoring.");
    expectAllowed("We will message you on WhatsApp when the invoice is ready.");
  });

  it("does not block ordinary UI labels, which are spaced rather than compounded", () => {
    expectAllowed("Open the Invoice List, use the Status dropdown, and choose All Unpaid.");
    expectAllowed("Go to Credit Notes and select Create Credit Note.");
    expectAllowed("The Period Summary report shows what was invoiced and collected.");
  });
});

describe("checkKnowledgeEntrySafety", () => {
  it("judges title, question and answer together", () => {
    expect(
      checkKnowledgeEntrySafety({
        title: "How are invoices stored?",
        question: "Where does the invoice go?",
        answer: "It is written to the MonthlyInvoiceMaster table.",
      }).safe,
    ).toBe(false);
  });

  it("passes a clean entry", () => {
    expect(
      checkKnowledgeEntrySafety({
        title: "Generating monthly invoices",
        question: "How do I generate invoices for this month?",
        answer: "Open Billing, choose Invoice List, then select Generate Invoices and confirm the period.",
      }).safe,
    ).toBe(true);
  });

  it("tolerates missing fields rather than throwing", () => {
    expect(checkKnowledgeEntrySafety({}).safe).toBe(true);
    expect(checkKnowledgeEntrySafety({ title: null, question: null, answer: null }).safe).toBe(true);
    expect(checkKnowledgeSafety("").safe).toBe(true);
  });
});

describe("describeViolation", () => {
  it("gives a reviewer plain language for every rule it can fire", () => {
    const ids = [
      "connection-string", "credential-literal", "private-key", "jwt", "private-address",
      "sql-statement", "schema-vocabulary", "table-reference", "code-fence", "code-syntax",
      "source-path", "dotnet-type", "stack-trace", "internal-endpoint", "infrastructure",
      "internal-identifier",
    ];
    for (const id of ids) {
      const description = describeViolation(id);
      expect(description).not.toBe("Contains information that should not reach a customer.");
      expect(description.length).toBeGreaterThan(10);
    }
  });

  it("falls back to something useful for an unknown id", () => {
    expect(describeViolation("nonsense")).toContain("should not reach a customer");
  });
});
