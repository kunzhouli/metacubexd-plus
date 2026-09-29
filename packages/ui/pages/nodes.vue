<script setup lang="ts">
import type {
  ManagedNode,
  ManualNodeGroup,
  NodePreviewItem,
  NodeSystemStatus,
} from '~/types/nodes'
import { toast } from 'vue-sonner'

const { t } = useI18n()
const { ready, hasFeature } = useControlInfo()
const api = useControlApi()
useHead({ title: computed(() => t('manualNodes')) })

const nodes = ref<ManagedNode[]>([])
const groups = ref<ManualNodeGroup[]>([])
const status = ref<NodeSystemStatus | null>(null)
const busy = ref(false)
const search = ref('')
const protocolFilter = ref('')
const tagFilter = ref('')
const statusFilter = ref('')
const sortBy = ref('name')
const selectedIds = ref<string[]>([])
const targetGroup = ref('')

const importModal = ref<{ open: () => void; close: () => void }>()
const editModal = ref<{ open: () => void; close: () => void }>()
const text = ref('')
const tagsText = ref('')
const preview = ref<NodePreviewItem[]>([])
const masked = ref(true)
const editing = ref<ManagedNode | null>(null)
const editUri = ref('')
const editName = ref('')
const editTags = ref('')
const editMasked = ref(true)
const quickTags = ['HK', 'JP', 'SG', 'US', '自建', '订阅']
const refreshTimers: ReturnType<typeof setTimeout>[] = []

const lines = computed(() =>
  text.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean),
)
const previewCounts = computed(() => ({
  valid: preview.value.filter((item) => item.valid && !item.duplicate).length,
  duplicate: preview.value.filter((item) => item.duplicate).length,
  invalid: preview.value.filter((item) => !item.valid).length,
}))
const protocols = computed(() =>
  [...new Set(nodes.value.map((node) => node.protocol))].sort(),
)
const tags = computed(() =>
  [...new Set(nodes.value.flatMap((node) => node.tags))].sort(),
)
const aliveCount = computed(
  () => nodes.value.filter((node) => node.alive === true).length,
)
const measuredCount = computed(
  () => nodes.value.filter((node) => node.delay !== null).length,
)
const selectedGroup = computed(() =>
  groups.value.find((group) => group.name === targetGroup.value),
)
const filteredNodes = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  const result = nodes.value.filter((node) => {
    if (
      query &&
      ![node.name, node.server, node.protocol, ...node.tags]
        .join(' ')
        .toLocaleLowerCase()
        .includes(query)
    )
      return false
    if (protocolFilter.value && node.protocol !== protocolFilter.value)
      return false
    if (tagFilter.value && !node.tags.includes(tagFilter.value)) return false
    if (statusFilter.value === 'alive' && node.alive !== true) return false
    if (statusFilter.value === 'offline' && node.alive !== false) return false
    if (statusFilter.value === 'unknown' && node.alive !== null) return false
    return true
  })
  return result.sort((a, b) => {
    if (sortBy.value === 'delay')
      return (
        (a.delay ?? Number.POSITIVE_INFINITY) -
          (b.delay ?? Number.POSITIVE_INFINITY) || a.name.localeCompare(b.name)
      )
    if (sortBy.value === 'recent') return b.updatedAt - a.updatedAt
    return a.name.localeCompare(b.name)
  })
})
const allVisibleSelected = computed(
  () =>
    filteredNodes.value.length > 0 &&
    filteredNodes.value.every((node) => selectedIds.value.includes(node.id)),
)

async function refresh() {
  status.value = await api.getNodeSystemStatus()
  if (status.value.providerReady && status.value.storageReady) {
    const [nodeList, groupList] = await Promise.all([
      api.listNodes(),
      api.listNodeGroups().catch(() => [] as ManualNodeGroup[]),
    ])
    nodes.value = nodeList
    groups.value = groupList
    selectedIds.value = selectedIds.value.filter((id) =>
      nodeList.some((node) => node.id === id),
    )
    if (!groupList.some((group) => group.name === targetGroup.value))
      targetGroup.value =
        groupList.find((group) => group.name === 'PROXY')?.name ??
        groupList[0]?.name ??
        ''
  } else {
    nodes.value = []
    groups.value = []
    selectedIds.value = []
  }
}

watch(
  ready,
  (value) => {
    if (value && hasFeature('nodes'))
      void refresh().catch(() => toast.error(t('manualNodesFailed')))
  },
  { immediate: true },
)
onUnmounted(() => refreshTimers.forEach(clearTimeout))

async function run(action: () => Promise<void>, success?: string) {
  if (busy.value) return
  busy.value = true
  try {
    await action()
    if (success) toast.success(success)
  } catch {
    // Never show raw upstream errors; they could include credentials.
    toast.error(t('manualNodesFailed'))
  } finally {
    busy.value = false
  }
}

function parsedTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ]
}

function toggleQuickTag(tag: string) {
  const current = new Set(parsedTags(tagsText.value))
  if (current.has(tag)) current.delete(tag)
  else current.add(tag)
  tagsText.value = [...current].join(', ')
}

function openImport() {
  text.value = ''
  tagsText.value = ''
  preview.value = []
  masked.value = true
  importModal.value?.open()
}

function clearImport() {
  text.value = ''
  tagsText.value = ''
  preview.value = []
}

function showPreview() {
  void run(async () => {
    preview.value = (await api.previewNodes(text.value)).items
  })
}

function importSelected() {
  void run(async () => {
    const selected = preview.value
      .filter((item) => item.valid && !item.duplicate)
      .map((item) => lines.value[item.index]!)
      .filter(Boolean)
    if (!selected.length) return
    const result = await api.importNodes(selected, parsedTags(tagsText.value))
    importModal.value?.close()
    text.value = ''
    preview.value = []
    await refresh()
    toast.success(
      t('manualNodesImportedCount', { count: result.imported.length }),
    )
  })
}

function toggleNode(id: string) {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((item) => item !== id)
    : [...selectedIds.value, id]
}

function toggleVisible() {
  const visible = new Set(filteredNodes.value.map((node) => node.id))
  selectedIds.value = allVisibleSelected.value
    ? selectedIds.value.filter((id) => !visible.has(id))
    : [...new Set([...selectedIds.value, ...visible])]
}

function deleteSelected() {
  const ids = [...selectedIds.value]
  if (
    !ids.length ||
    !window.confirm(
      t('manualNodesDeleteSelectedConfirm', { count: ids.length }),
    )
  )
    return
  void run(async () => {
    await api.deleteNodes(ids)
    selectedIds.value = []
    await refresh()
  }, t('manualNodesDeleted'))
}

function deleteNode(node: ManagedNode) {
  if (!window.confirm(t('manualNodesDeleteConfirm', { name: node.name })))
    return
  void run(async () => {
    await api.deleteNode(node.id)
    await refresh()
  }, t('manualNodesDeleted'))
}

function beginEdit(node: ManagedNode) {
  void run(async () => {
    editUri.value = (await api.getNodeUri(node.id)).uri
    editName.value = node.name
    editTags.value = node.tags.join(', ')
    editMasked.value = true
    editing.value = node
    await nextTick()
    editModal.value?.open()
  })
}

function saveEdit() {
  const node = editing.value
  if (!node) return
  void run(async () => {
    await api.updateNode(node.id, {
      uri: editUri.value,
      name: editName.value,
      tags: parsedTags(editTags.value),
      revision: node.updatedAt,
    })
    editModal.value?.close()
    editUri.value = ''
    editing.value = null
    await refresh()
  }, t('manualNodesSaved'))
}

function cancelEdit() {
  editModal.value?.close()
  editUri.value = ''
  editing.value = null
}

function clearEdit() {
  editUri.value = ''
  editing.value = null
}

function copyNode(node: ManagedNode) {
  void run(async () => {
    const { uri } = await api.getNodeUri(node.id)
    await navigator.clipboard.writeText(uri)
  }, t('manualNodesCopied'))
}

function testNode(node: ManagedNode) {
  void run(async () => {
    await api.testNode(node.id)
    await refresh()
  }, t('manualNodesTested'))
}

function selectNode(node: ManagedNode) {
  const group = selectedGroup.value
  if (!group || !group.members.includes(node.name)) return
  void run(async () => {
    await api.selectNode(node.id, group.name)
    await refresh()
  }, t('manualNodesUseSuccess'))
}

function healthcheck() {
  void run(async () => {
    await api.healthcheckManualProvider()
    await refresh()
    for (const delay of [2000, 6000, 12000])
      refreshTimers.push(
        setTimeout(() => void refresh().catch(() => {}), delay),
      )
  }, t('manualNodesHealthcheckStarted'))
}

function reload() {
  void run(async () => {
    await api.reloadManualProvider()
    await refresh()
  }, t('manualNodesReloaded'))
}
</script>

<template>
  <div class="mx-auto w-full max-w-7xl space-y-5 p-4 sm:p-6">
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold">{{ t('manualNodes') }}</h1>
        <p class="mt-1 text-sm text-base-content/60">
          {{ t('manualNodesDescription') }}
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button
          class="btn btn-ghost btn-sm"
          :disabled="busy"
          @click="void run(refresh)"
        >
          {{ t('manualNodesRefresh') }}
        </button>
        <button
          class="btn btn-primary btn-sm"
          :disabled="busy || !status?.storageReady"
          @click="openImport"
        >
          + {{ t('manualNodesAddByLink') }}
        </button>
      </div>
    </header>

    <div class="tabs-boxed tabs w-fit" role="tablist">
      <NuxtLink to="/nodes" class="tab tab-active">{{
        t('manualNodesList')
      }}</NuxtLink>
      <NuxtLink to="/nodes/subscriptions" class="tab">{{
        t('subscriptionsTitle')
      }}</NuxtLink>
    </div>

    <div v-if="ready && !hasFeature('nodes')" class="alert alert-warning">
      {{ t('manualNodesUnavailable') }}
    </div>
    <template v-else>
      <div
        v-if="
          status &&
          (!status.mihomoReachable ||
            !status.providerReady ||
            !status.storageReady)
        "
        class="alert alert-warning"
      >
        {{ t('manualNodesSetupNeeded') }}
      </div>

      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div
          class="rounded-xl border border-base-content/10 bg-base-200 px-4 py-3"
        >
          <div class="text-xs text-base-content/55">
            {{ t('manualNodesList') }}
          </div>
          <div class="mt-1 text-2xl font-semibold tabular-nums">
            {{ nodes.length }}
          </div>
        </div>
        <div
          class="rounded-xl border border-base-content/10 bg-base-200 px-4 py-3"
        >
          <div class="text-xs text-base-content/55">
            {{ t('manualNodesAlive') }}
          </div>
          <div class="mt-1 text-2xl font-semibold text-success tabular-nums">
            {{ aliveCount }}
          </div>
        </div>
        <div
          class="rounded-xl border border-base-content/10 bg-base-200 px-4 py-3"
        >
          <div class="text-xs text-base-content/55">
            {{ t('manualNodesMeasured') }}
          </div>
          <div class="mt-1 text-2xl font-semibold tabular-nums">
            {{ measuredCount }}
          </div>
        </div>
        <div
          class="rounded-xl border border-base-content/10 bg-base-200 px-4 py-3"
        >
          <div class="text-xs text-base-content/55">manual Provider</div>
          <div class="mt-2 flex items-center gap-2 text-sm font-medium">
            <span
              class="h-2.5 w-2.5 rounded-full"
              :class="status?.providerReady ? 'bg-success' : 'bg-warning'"
            />
            {{
              status?.providerReady
                ? t('manualNodesProviderReady')
                : t('manualNodesProviderDown')
            }}
          </div>
        </div>
      </div>

      <section
        class="rounded-2xl border border-base-content/10 bg-base-200 p-4 sm:p-5"
      >
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 class="text-lg font-semibold">{{ t('manualNodesList') }}</h2>
            <p class="text-xs text-base-content/55">
              {{ filteredNodes.length }} / {{ nodes.length }}
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              class="btn btn-outline btn-sm"
              :disabled="busy || !nodes.length"
              @click="healthcheck"
            >
              {{ t('manualNodesHealthcheck') }}
            </button>
            <button
              class="btn btn-ghost btn-sm"
              :disabled="busy || !status?.providerReady"
              @click="reload"
            >
              {{ t('manualNodesReload') }}
            </button>
          </div>
        </div>

        <div
          class="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(12rem,1fr)_repeat(4,minmax(7rem,auto))]"
        >
          <input
            v-model="search"
            type="search"
            class="input-bordered input w-full input-sm"
            :placeholder="t('manualNodesSearch')"
            :aria-label="t('manualNodesSearch')"
          />
          <select
            v-model="protocolFilter"
            class="select-bordered select w-full select-sm"
            :aria-label="t('manualNodesProtocol')"
          >
            <option value="">{{ t('manualNodesAllProtocols') }}</option>
            <option
              v-for="protocol in protocols"
              :key="protocol"
              :value="protocol"
            >
              {{ protocol }}
            </option>
          </select>
          <select
            v-model="tagFilter"
            class="select-bordered select w-full select-sm"
            :aria-label="t('manualNodesTags')"
          >
            <option value="">{{ t('manualNodesAllTags') }}</option>
            <option v-for="tag in tags" :key="tag" :value="tag">
              {{ tag }}
            </option>
          </select>
          <select
            v-model="statusFilter"
            class="select-bordered select w-full select-sm"
            :aria-label="t('status')"
          >
            <option value="">{{ t('manualNodesAllStatus') }}</option>
            <option value="alive">{{ t('manualNodesAlive') }}</option>
            <option value="offline">{{ t('manualNodesOffline') }}</option>
            <option value="unknown">{{ t('manualNodesUnknown') }}</option>
          </select>
          <select
            v-model="sortBy"
            class="select-bordered select w-full select-sm"
            :aria-label="t('manualNodesSort')"
          >
            <option value="name">{{ t('manualNodesSortName') }}</option>
            <option value="delay">{{ t('manualNodesSortDelay') }}</option>
            <option value="recent">{{ t('manualNodesSortRecent') }}</option>
          </select>
        </div>

        <div
          v-if="groups.length"
          class="mt-3 flex flex-wrap items-center gap-2 text-sm"
        >
          <label for="manual-node-group" class="text-base-content/60">{{
            t('manualNodesTargetGroup')
          }}</label>
          <select
            id="manual-node-group"
            v-model="targetGroup"
            class="select-bordered select max-w-xs select-sm"
          >
            <option
              v-for="group in groups"
              :key="group.name"
              :value="group.name"
            >
              {{ group.name }}
            </option>
          </select>
          <span v-if="selectedGroup?.now" class="text-base-content/55">
            {{ t('manualNodesCurrent') }}: {{ selectedGroup.now }}
          </span>
        </div>

        <div
          v-if="selectedIds.length"
          class="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-primary/25 bg-primary/5 p-2 text-sm"
        >
          <strong>{{
            t('manualNodesSelected', { count: selectedIds.length })
          }}</strong>
          <button class="btn btn-ghost btn-xs" @click="selectedIds = []">
            {{ t('manualNodesClearSelection') }}
          </button>
          <button
            class="btn ml-auto btn-error btn-xs"
            :disabled="busy"
            @click="deleteSelected"
          >
            {{ t('manualNodesDeleteSelected') }}
          </button>
        </div>

        <div v-if="!nodes.length" class="py-14 text-center">
          <p class="text-base-content/60">{{ t('manualNodesEmpty') }}</p>
          <button
            class="btn mt-4 btn-primary btn-sm"
            :disabled="!status?.storageReady"
            @click="openImport"
          >
            {{ t('manualNodesAddByLink') }}
          </button>
        </div>
        <p
          v-else-if="!filteredNodes.length"
          class="py-14 text-center text-base-content/60"
        >
          {{ t('manualNodesNoMatches') }}
        </p>
        <template v-else>
          <div class="mt-4 hidden overflow-x-auto md:block">
            <table class="table w-full table-sm">
              <thead>
                <tr>
                  <th class="w-8">
                    <input
                      type="checkbox"
                      class="checkbox checkbox-sm"
                      :checked="allVisibleSelected"
                      :aria-label="t('manualNodesSelectAllVisible')"
                      @change="toggleVisible"
                    />
                  </th>
                  <th>{{ t('manualNodesName') }}</th>
                  <th>{{ t('manualNodesProtocol') }}</th>
                  <th>{{ t('status') }}</th>
                  <th>{{ t('manualNodesDelay') }}</th>
                  <th>{{ t('manualNodesTags') }}</th>
                  <th class="text-right">{{ t('manualNodesActions') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="node in filteredNodes"
                  :key="node.id"
                  :class="selectedIds.includes(node.id) ? 'bg-primary/5' : ''"
                >
                  <td>
                    <input
                      type="checkbox"
                      class="checkbox checkbox-sm"
                      :checked="selectedIds.includes(node.id)"
                      :aria-label="node.name"
                      @change="toggleNode(node.id)"
                    />
                  </td>
                  <td>
                    <div class="font-medium">{{ node.name }}</div>
                    <div class="text-xs text-base-content/55">
                      {{ node.server }}:{{ node.port }}
                    </div>
                  </td>
                  <td>
                    <span class="badge badge-ghost badge-sm uppercase">{{
                      node.protocol
                    }}</span>
                  </td>
                  <td>
                    <span class="inline-flex items-center gap-1.5 text-xs">
                      <span
                        class="h-2 w-2 rounded-full"
                        :class="
                          node.alive === true
                            ? 'bg-success'
                            : node.alive === false
                              ? 'bg-error'
                              : 'bg-base-content/30'
                        "
                      />
                      {{
                        node.alive === true
                          ? t('manualNodesAlive')
                          : node.alive === false
                            ? t('manualNodesOffline')
                            : t('manualNodesUnknown')
                      }}
                    </span>
                  </td>
                  <td
                    class="tabular-nums"
                    :class="
                      node.delay !== null && node.delay < 200
                        ? 'text-success'
                        : ''
                    "
                  >
                    {{ node.delay === null ? '—' : `${node.delay} ms` }}
                  </td>
                  <td>
                    <span
                      v-for="tag in node.tags"
                      :key="tag"
                      class="mr-1 badge badge-outline badge-sm"
                      >{{ tag }}</span
                    >
                  </td>
                  <td class="text-right whitespace-nowrap">
                    <button
                      v-if="selectedGroup?.members.includes(node.name)"
                      class="btn btn-ghost btn-primary btn-xs"
                      :disabled="busy || selectedGroup.now === node.name"
                      @click="selectNode(node)"
                    >
                      {{
                        selectedGroup.now === node.name
                          ? t('manualNodesInUse')
                          : t('manualNodesUse')
                      }}
                    </button>
                    <button
                      class="btn btn-ghost btn-xs"
                      :disabled="busy"
                      @click="testNode(node)"
                    >
                      {{ t('manualNodesTest') }}
                    </button>
                    <button
                      class="btn btn-ghost btn-xs"
                      :disabled="busy"
                      @click="copyNode(node)"
                    >
                      {{ t('manualNodesCopy') }}
                    </button>
                    <button
                      class="btn btn-ghost btn-xs"
                      :disabled="busy"
                      @click="beginEdit(node)"
                    >
                      {{ t('manualNodesEdit') }}
                    </button>
                    <button
                      class="btn btn-ghost text-error btn-xs"
                      :disabled="busy"
                      @click="deleteNode(node)"
                    >
                      {{ t('manualNodesDelete') }}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="mt-4 space-y-2 md:hidden">
            <label class="flex items-center gap-2 text-xs text-base-content/60">
              <input
                type="checkbox"
                class="checkbox checkbox-sm"
                :checked="allVisibleSelected"
                @change="toggleVisible"
              />
              {{ t('manualNodesSelectAllVisible') }}
            </label>
            <article
              v-for="node in filteredNodes"
              :key="node.id"
              class="rounded-xl border border-base-content/10 bg-base-100 p-3"
            >
              <div class="flex items-start gap-3">
                <input
                  type="checkbox"
                  class="checkbox mt-1 checkbox-sm"
                  :checked="selectedIds.includes(node.id)"
                  :aria-label="node.name"
                  @change="toggleNode(node.id)"
                />
                <div class="min-w-0 flex-1">
                  <div class="truncate font-medium">{{ node.name }}</div>
                  <div class="text-xs break-all text-base-content/55">
                    {{ node.protocol.toUpperCase() }} · {{ node.server }}:{{
                      node.port
                    }}
                  </div>
                </div>
                <div class="text-right text-xs tabular-nums">
                  <div
                    :class="
                      node.alive === true
                        ? 'text-success'
                        : node.alive === false
                          ? 'text-error'
                          : 'text-base-content/55'
                    "
                  >
                    {{
                      node.alive === true
                        ? t('manualNodesAlive')
                        : node.alive === false
                          ? t('manualNodesOffline')
                          : t('manualNodesUnknown')
                    }}
                  </div>
                  <div class="mt-1">
                    {{ node.delay === null ? '—' : `${node.delay} ms` }}
                  </div>
                </div>
              </div>
              <div
                v-if="node.tags.length"
                class="mt-2 flex flex-wrap gap-1 pl-8"
              >
                <span
                  v-for="tag in node.tags"
                  :key="tag"
                  class="badge badge-outline badge-sm"
                  >{{ tag }}</span
                >
              </div>
              <div
                class="mt-3 flex flex-wrap gap-1 border-t border-base-content/10 pt-2 pl-7"
              >
                <button
                  v-if="selectedGroup?.members.includes(node.name)"
                  class="btn btn-ghost btn-primary btn-xs"
                  :disabled="busy || selectedGroup.now === node.name"
                  @click="selectNode(node)"
                >
                  {{
                    selectedGroup.now === node.name
                      ? t('manualNodesInUse')
                      : t('manualNodesUse')
                  }}
                </button>
                <button
                  class="btn btn-ghost btn-xs"
                  :disabled="busy"
                  @click="testNode(node)"
                >
                  {{ t('manualNodesTest') }}
                </button>
                <button
                  class="btn btn-ghost btn-xs"
                  :disabled="busy"
                  @click="copyNode(node)"
                >
                  {{ t('manualNodesCopy') }}
                </button>
                <button
                  class="btn btn-ghost btn-xs"
                  :disabled="busy"
                  @click="beginEdit(node)"
                >
                  {{ t('manualNodesEdit') }}
                </button>
                <button
                  class="btn btn-ghost text-error btn-xs"
                  :disabled="busy"
                  @click="deleteNode(node)"
                >
                  {{ t('manualNodesDelete') }}
                </button>
              </div>
            </article>
          </div>
        </template>
      </section>
    </template>

    <Modal
      ref="importModal"
      :title="t('manualNodesAddByLink')"
      size="xl"
      @close="clearImport"
    >
      <p class="mb-3 text-sm text-base-content/60">
        {{ t('manualNodesPasteHint') }}
      </p>
      <div class="relative">
        <textarea
          v-model="text"
          rows="7"
          class="textarea-bordered textarea w-full font-mono"
          :class="masked ? 'text-transparent caret-base-content' : ''"
          :aria-label="t('manualNodesUris')"
          :placeholder="masked ? '' : t('manualNodesPasteHint')"
          autocomplete="off"
          spellcheck="false"
          @input="preview = []"
        />
        <div
          v-if="masked"
          class="pointer-events-none absolute inset-1 rounded bg-base-100 p-3 text-sm text-base-content/60"
        >
          {{
            lines.length
              ? t('manualNodesMaskedCount', { count: lines.length })
              : t('manualNodesPasteHint')
          }}
        </div>
      </div>
      <label class="mt-2 flex cursor-pointer items-center gap-2 text-sm">
        <input
          v-model="masked"
          type="checkbox"
          class="checkbox checkbox-sm"
        />{{ t('manualNodesMask') }}
      </label>
      <label class="mt-4 block text-sm">
        {{ t('manualNodesTags') }}
        <input
          v-model="tagsText"
          class="input-bordered input mt-1 w-full"
          maxlength="540"
          autocomplete="off"
        />
      </label>
      <div class="mt-2 flex flex-wrap gap-1">
        <button
          v-for="tag in quickTags"
          :key="tag"
          type="button"
          class="btn btn-xs"
          :class="
            parsedTags(tagsText).includes(tag) ? 'btn-primary' : 'btn-ghost'
          "
          @click="toggleQuickTag(tag)"
        >
          {{ tag }}
        </button>
      </div>
      <div
        v-if="preview.length"
        class="mt-4 rounded-xl border border-base-content/10 bg-base-200 p-3"
      >
        <h3 class="text-sm font-semibold">{{ t('manualNodesPreview') }}</h3>
        <p class="mt-1 text-xs text-base-content/60">
          {{ t('manualNodesPreviewSummary', previewCounts) }}
        </p>
        <ul
          class="mt-3 max-h-48 space-y-1 overflow-y-auto text-sm"
          :aria-label="t('manualNodesPreview')"
        >
          <li
            v-for="item in preview"
            :key="item.index"
            class="flex flex-wrap gap-x-2 rounded bg-base-100 px-2 py-1"
          >
            <span class="text-base-content/50">#{{ item.index + 1 }}</span>
            <template v-if="item.valid">
              <strong>{{ item.name }}</strong
              ><span class="text-base-content/60"
                >{{ item.protocol }} · {{ item.server }}:{{ item.port }}</span
              >
              <span
                v-if="item.duplicate"
                class="badge badge-sm badge-warning"
                >{{ t('manualNodesDuplicate') }}</span
              >
            </template>
            <span v-else class="text-error">{{
              item.error === 'UNSUPPORTED_NODE_PROTOCOL'
                ? t('manualNodesUnsupported')
                : t('manualNodesInvalid')
            }}</span>
          </li>
        </ul>
      </div>
      <template #actions>
        <button
          class="btn btn-ghost"
          :disabled="busy"
          @click="importModal?.close()"
        >
          {{ t('manualNodesCancel') }}
        </button>
        <button
          class="btn btn-outline"
          :disabled="busy || !lines.length"
          @click="showPreview"
        >
          {{ t('manualNodesPreview') }}
        </button>
        <button
          class="btn btn-primary"
          :disabled="busy || !previewCounts.valid"
          @click="importSelected"
        >
          {{ t('manualNodesImport')
          }}<span v-if="previewCounts.valid"> ({{ previewCounts.valid }})</span>
        </button>
      </template>
    </Modal>

    <Modal ref="editModal" :title="t('manualNodesEdit')" @close="clearEdit">
      <div v-if="editing" class="space-y-4">
        <label class="block text-sm"
          >{{ t('manualNodesName') }}
          <input
            v-model="editName"
            class="input-bordered input mt-1 w-full"
            maxlength="128"
          />
        </label>
        <label class="block text-sm"
          >{{ t('manualNodesUris') }}
          <input
            v-model="editUri"
            :type="editMasked ? 'password' : 'text'"
            class="input-bordered input mt-1 w-full font-mono"
            autocomplete="off"
            spellcheck="false"
          />
        </label>
        <label class="flex cursor-pointer items-center gap-2 text-sm">
          <input
            v-model="editMasked"
            type="checkbox"
            class="checkbox checkbox-sm"
          />{{ t('manualNodesMask') }}
        </label>
        <label class="block text-sm"
          >{{ t('manualNodesTags') }}
          <input
            v-model="editTags"
            class="input-bordered input mt-1 w-full"
            autocomplete="off"
          />
        </label>
      </div>
      <template #actions>
        <button class="btn btn-ghost" @click="cancelEdit">
          {{ t('manualNodesCancel') }}
        </button>
        <button
          class="btn btn-primary"
          :disabled="busy || !editUri.trim()"
          @click="saveEdit"
        >
          {{ t('manualNodesSave') }}
        </button>
      </template>
    </Modal>
  </div>
</template>
