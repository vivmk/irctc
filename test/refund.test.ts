import { describe, expect, it } from "vitest";
import { refundFor } from "../src/refund";

const FEE = 6000;
const r = (hoursBefore: number, passengers = 1, waitlisted = false) =>
  refundFor(
    { amountPaise: 50000 * passengers, passengers, hoursBefore, waitlisted },
    FEE,
  );

describe("refund rules", () => {
  it("more than 48 hours: refund minus a fee per passenger", () => {
    expect(r(100)).toBe(44000);
    expect(r(100, 2)).toBe(88000);
    expect(r(48.01)).toBe(44000);
  });
  it("12 to 48 hours: 75%, both edges included", () => {
    expect(r(48)).toBe(37500);
    expect(r(24)).toBe(37500);
    expect(r(12)).toBe(37500);
  });
  it("under 12 hours: nothing", () => {
    expect(r(11.99)).toBe(0);
    expect(r(0.5)).toBe(0);
  });
  it("waiting-list bookings always get everything back", () => {
    expect(r(100, 1, true)).toBe(50000);
    expect(r(2, 1, true)).toBe(50000);
  });
  it("the fee can never push a refund below zero", () => {
    expect(
      refundFor(
        {
          amountPaise: 5000,
          passengers: 1,
          hoursBefore: 100,
          waitlisted: false,
        },
        FEE,
      ),
    ).toBe(0);
  });
  it("rounds down to whole paise", () => {
    expect(
      refundFor(
        {
          amountPaise: 50001,
          passengers: 1,
          hoursBefore: 20,
          waitlisted: false,
        },
        FEE,
      ),
    ).toBe(37500);
  });
});
