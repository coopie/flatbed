import type { Person } from '$lib/server/host.ts';

declare global {
  namespace App {
    interface Locals {
      person?: Person;
    }
  }
}

export {};
