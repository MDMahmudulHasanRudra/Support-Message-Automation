import { describe, expect, it } from "vitest";
import { formatPaymentAmount, gatewayAmount, parseLinkAmount, readGatewayAmount } from "../index.js";

describe("money crossing to a gateway", () => {
  it("reads what people type", () => {
    expect(parseLinkAmount("1,500")).toBe(BigInt(150000));
    expect(parseLinkAmount("1500.5")).toBe(BigInt(150050));
    expect(parseLinkAmount("0")).toBeNull();
    expect(parseLinkAmount("-5")).toBeNull();
    expect(parseLinkAmount("1.999")).toBeNull();
    expect(parseLinkAmount("abc")).toBeNull();
  });
  it("speaks to the gateway in exact decimals", () => {
    expect(gatewayAmount(BigInt(150005))).toBe("1500.05");
  });
  it("reads the gateway's answer exactly, never rounding", () => {
    expect(readGatewayAmount("1500.00")).toBe(BigInt(150000));
    expect(readGatewayAmount("1500.0000")).toBe(BigInt(150000));
    expect(readGatewayAmount(1500)).toBe(BigInt(150000));
    expect(readGatewayAmount("1500.0049")).toBeNull();
    expect(readGatewayAmount("free")).toBeNull();
    expect(readGatewayAmount(undefined)).toBeNull();
  });
  it("shows an amount the way people write it", () => {
    expect(formatPaymentAmount(BigInt(150000))).toBe("BDT 1,500");
    expect(formatPaymentAmount(BigInt(150050))).toBe("BDT 1,500.50");
  });
});
