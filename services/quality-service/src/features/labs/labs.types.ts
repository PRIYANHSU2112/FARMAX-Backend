export interface LabInput {
  code: string;
  name: string;
  accreditation?: string | null;
  type: 'IN_HOUSE' | 'EXTERNAL';
  tatDays?: number;
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  address?: string | null;
  status?: 'ACTIVE' | 'INACTIVE';
}

export type LabUpdate = Partial<Omit<LabInput, 'code'>> & { expectedVersion: number };
