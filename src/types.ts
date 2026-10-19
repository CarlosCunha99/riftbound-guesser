export interface Card {
  id: string;
  name: string;
  title: string;
  type: string;
  domain: string;
  cost: number | null;
  power: number | null;
  might: number | null;
  set: string;
  setCode: string;
  rarity: string | null;
  image: string | null;
  /** Type labels beyond the main type, for example Champion or Signature. */
  labels?: string[];
  tags?: string[];
  ability?: string | null;
  artist?: string | null;
}

export type ClueStatus = 'hit' | 'near' | 'miss';
export type Direction = 'up' | 'down' | null;
export type AttrKey = 'type' | 'domain' | 'cost' | 'power' | 'might' | 'set';

export interface Clue {
  key: AttrKey;
  status: ClueStatus;
  /** Direction of the answer relative to the guess ("up" = answer is higher). */
  dir: Direction;
  value: string | number | null;
}

export const ATTRS: { key: AttrKey; label: string; short: string; numeric: boolean }[] = [
  { key: 'type', label: 'Type', short: 'Type', numeric: false },
  { key: 'domain', label: 'Domain', short: 'Dom', numeric: false },
  { key: 'cost', label: 'Cost', short: 'Cost', numeric: true },
  { key: 'power', label: 'Power', short: 'Pow', numeric: true },
  { key: 'might', label: 'Might', short: 'Might', numeric: true },
  { key: 'set', label: 'Set', short: 'Set', numeric: false },
];

export const MAX_GUESSES = 10;
