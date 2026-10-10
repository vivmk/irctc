export function refundFor(
  a: {
    amountPaise: number;
    passengers: number;
    hoursBefore: number;
    waitlisted: boolean;
  },
  feePaise: number,
): number {
  if (a.waitlisted) return a.amountPaise; // never got a seat: full refund
  if (a.hoursBefore > 48)
    return Math.max(0, a.amountPaise - feePaise * a.passengers);
  if (a.hoursBefore >= 12) return Math.floor(a.amountPaise * 0.75);
  return 0;
}
