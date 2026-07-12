import type { LucideIcon } from 'lucide-react';

export interface AboutPanelSection {
  icon: LucideIcon;
  title: string;
  description?: string;
  bullets: string[];
}

export interface AboutPanelContent {
  subtitle: string;
  intro: string;
  tags: string[];
  sections: AboutPanelSection[];
  contactTitle: string;
  contactDescription: string;
  email: string;
}
