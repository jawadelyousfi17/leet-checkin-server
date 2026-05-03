export type ApiUser = {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  githubUsername: string | null;
  githubId: string | null;
  lastSignInAt: string | null;
  phoneNumber: string | null;
  whatsappNumber: string | null;
  webhookUrl: string | null;
  emailEnabled: boolean;
  smsEnabled: boolean;
  callEnabled: boolean;
  whatsappEnabled: boolean;
  webhookEnabled: boolean;
  monitoringStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function getAllUsers(): Promise<ApiUser[]> {
  const host = process.env.HOST_API;
  const token = process.env.ALL_USERS_API_TOKEN;
  if (!host || !token) {
    throw new Error("HOST_API or ALL_USERS_API_TOKEN not set");
  }
  const url = `${host.replace(/\/$/, "")}/api/all-users`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`users API ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { count?: number; users?: ApiUser[] };
  return json.users ?? [];
}
