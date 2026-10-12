import { describe, expect, it } from "vitest";
import { refundFor } from "../src/refund";

const FEE = 6000;
const r = (hoursBefore: number, passengers = 1, waitlisted = false) =>
  refundFor({ amountPaise: 50000 * passengers, passengers, hoursBefore, waitlisted }, FEE);

describe("refundFor", () => {
  it("more than 48 hours before: refund minus the fee per passenger", () => {
    expect(r(100)).toBe(44000);
    expect(r(100, 2)).toBe(88000);
    expect(r(48.01)).toBe(44000);
  });

  it("between 12 and 48 hours: 75%, edges included", () => {
    expect(r(48)).toBe(37500);
    expect(r(24)).toBe(37500);
    expect(r(12)).toBe(37500);
    expect(r(24, 2)).toBe(75000);
  });

  it("under 12 hours: nothing", () => {
    expect(r(11.99)).toBe(0);
    expect(r(0.5)).toBe(0);
  });

  it("waiting-list bookings always get everything back, at any time", () => {
    expect(r(100, 1, true)).toBe(50000);
    expect(r(2, 1, true)).toBe(50000);
    expect(r(0.1, 3, true)).toBe(150000);
  });

  it("the fee can never push a refund below zero", () => {
    expect(refundFor({ amountPaise: 5000, passengers: 1, hoursBefore: 100, waitlisted: false }, FEE)).toBe(0);
    expect(refundFor({ amountPaise: 6000, passengers: 1, hoursBefore: 100, waitlisted: false }, FEE)).toBe(0);
  });

  it("rounds the 75% down to whole paise", () => {
    expect(refundFor({ amountPaise: 50001, passengers: 1, hoursBefore: 20, waitlisted: false }, FEE)).toBe(37500);
    expect(refundFor({ amountPaise: 3, passengers: 1, hoursBefore: 20, waitlisted: false }, FEE)).toBe(2);
  });

  it("never refunds more than was paid, in any tier", () => {
    for (const h of [0.5, 11.9, 12, 30, 48, 49, 500]) {
      for (const pax of [1, 2, 6]) {
        const paid = 50000 * pax;
        expect(refundFor({ amountPaise: paid, passengers: pax, hoursBefore: h, waitlisted: false }, FEE)).toBeLessThanOrEqual(paid);
        expect(refundFor({ amountPaise: paid, passengers: pax, hoursBefore: h, waitlisted: false }, FEE)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("a bigger fee means a smaller refund (only in the 48h+ tier)", () => {
    expect(refundFor({ amountPaise: 50000, passengers: 1, hoursBefore: 100, waitlisted: false }, 10000)).toBe(40000);
    expect(refundFor({ amountPaise: 50000, passengers: 1, hoursBefore: 24, waitlisted: false }, 10000)).toBe(37500);
  });
});
