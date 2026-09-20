export type MemberUser = {
  userId: string;
  email: string;
  fullName?: string | null;
  avatarUrl?: string | null;
};

export const MEMBER_USER_KEY = 'memberUser';
