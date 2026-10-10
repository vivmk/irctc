let smsDown = false;
export const setSmsDown = (v: boolean) => {
  smsDown = v;
};

export async function sendEmail(_to: string, _body: string): Promise<void> {
  // a real provider call goes here later
}

export async function sendSms(_to: string, _body: string): Promise<void> {
  if (smsDown) throw new Error("SMS provider unavailable");
}
