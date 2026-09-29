export interface ManagedNode {
  id: string
  name: string
  protocol: string
  server: string
  port: number
  tags: string[]
  alive: boolean | null
  delay: number | null
  createdAt: number
  updatedAt: number
}

export interface NodePreviewItem {
  index: number
  valid: boolean
  protocol?: string
  name?: string
  server?: string
  port?: number
  duplicate?: boolean
  error?: string
}

export interface NodeSystemStatus {
  mihomoReachable: boolean
  providerReady: boolean
  storageReady: boolean
  providerPath: string
}

export interface ManualNodeGroup {
  name: string
  now: string
  members: string[]
}

export interface NodeSubscription {
  id: string
  name: string
  host: string
  format: 'uri' | 'yaml'
  intervalHours: number
  count: number
  createdAt: number
  updatedAt: number
  lastUpdatedAt: number
  lastError: string | null
}

export interface SubscriptionPreview {
  format: 'uri' | 'yaml'
  count: number
  items: Array<{ name: string; protocol: string; server: string; port: number }>
}
