<script setup lang="ts">
import { toast } from 'vue-sonner'
import type { NodeSubscription, SubscriptionPreview } from '~/types/nodes'

const { t } = useI18n()
const { ready, hasFeature } = useControlInfo()
const api = useControlApi()
useHead({ title: computed(() => t('subscriptionsTitle')) })

const sources = ref<NodeSubscription[]>([])
const providerReady = ref(false)
const busy = ref(false)
const formModal = ref<{ open: () => void; close: () => void }>()
const editing = ref<NodeSubscription | null>(null)
const name = ref('')
const url = ref('')
const intervalHours = ref(24)
const showUrl = ref(false)
const preview = ref<SubscriptionPreview | null>(null)

async function refresh() {
  const [list, status] = await Promise.all([
    api.listSubscriptions(),
    api.getSubscriptionStatus(),
  ])
  sources.value = list
  providerReady.value = status.providerReady
}

watch(
  ready,
  (value) => {
    if (value && hasFeature('subscriptions'))
      void refresh().catch(() => toast.error(t('subscriptionsFailed')))
  },
  { immediate: true },
)

async function run(action: () => Promise<void>, message?: string) {
  if (busy.value) return
  busy.value = true
  try {
    await action()
    if (message) toast.success(message)
  } catch {
    toast.error(t('subscriptionsFailed'))
  } finally {
    busy.value = false
  }
}

function clearForm() {
  url.value = ''
  name.value = ''
  intervalHours.value = 24
  editing.value = null
  preview.value = null
  showUrl.value = false
}

function openAdd() {
  clearForm()
  formModal.value?.open()
}

function openEdit(source: NodeSubscription) {
  void run(async () => {
    clearForm()
    editing.value = source
    name.value = source.name
    intervalHours.value = source.intervalHours
    url.value = (await api.getSubscriptionUrl(source.id)).url
    formModal.value?.open()
  })
}

function previewLink() {
  void run(async () => {
    preview.value = await api.previewSubscription(url.value)
  })
}

function save() {
  void run(async () => {
    const body = {
      name: name.value,
      url: url.value,
      intervalHours: Number(intervalHours.value),
    }
    if (editing.value) await api.updateSubscription(editing.value.id, body)
    else await api.addSubscription(body)
    formModal.value?.close()
    clearForm()
    await refresh()
  }, t('subscriptionsSaved'))
}

function remove(source: NodeSubscription) {
  if (!window.confirm(t('subscriptionsDeleteConfirm', { name: source.name })))
    return
  void run(async () => {
    await api.deleteSubscription(source.id)
    await refresh()
  }, t('subscriptionsDeleted'))
}

function updateNow(source: NodeSubscription) {
  void run(async () => {
    await api.refreshSubscription(source.id)
    await refresh()
  }, t('subscriptionsUpdated'))
}

function healthcheck() {
  void run(async () => {
    await api.healthcheckSubscriptions()
  }, t('manualNodesHealthcheckStarted'))
}

function date(value: number) {
  return value ? new Date(value).toLocaleString() : '—'
}
</script>

<template>
  <div class="mx-auto w-full max-w-7xl space-y-5 p-4 sm:p-6">
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold">{{ t('manualNodes') }}</h1>
        <p class="mt-1 text-sm text-base-content/60">
          {{ t('subscriptionsDescription') }}
        </p>
      </div>
      <button
        class="btn btn-primary btn-sm"
        :disabled="busy || !providerReady"
        @click="openAdd"
      >
        + {{ t('subscriptionsAdd') }}
      </button>
    </header>
    <div class="tabs-boxed tabs w-fit" role="tablist">
      <NuxtLink to="/nodes" class="tab">{{ t('manualNodesList') }}</NuxtLink>
      <NuxtLink to="/nodes/subscriptions" class="tab tab-active">{{
        t('subscriptionsTitle')
      }}</NuxtLink>
    </div>
    <div
      v-if="ready && !hasFeature('subscriptions')"
      class="alert alert-warning"
    >
      {{ t('manualNodesUnavailable') }}
    </div>
    <template v-else>
      <div v-if="!providerReady" class="alert alert-warning">
        {{ t('subscriptionsSetupNeeded') }}
      </div>
      <div class="grid gap-3 sm:grid-cols-3">
        <div class="rounded-xl border border-base-content/10 bg-base-200 p-4">
          <div class="text-xs text-base-content/60">
            {{ t('subscriptionsTitle') }}
          </div>
          <div class="mt-1 text-2xl font-semibold">{{ sources.length }}</div>
        </div>
        <div class="rounded-xl border border-base-content/10 bg-base-200 p-4">
          <div class="text-xs text-base-content/60">
            {{ t('manualNodesList') }}
          </div>
          <div class="mt-1 text-2xl font-semibold">
            {{ sources.reduce((sum, item) => sum + item.count, 0) }}
          </div>
        </div>
        <div class="rounded-xl border border-base-content/10 bg-base-200 p-4">
          <div class="text-xs text-base-content/60">Provider</div>
          <div class="mt-2 flex items-center gap-2 text-sm">
            <span
              class="h-2 w-2 rounded-full"
              :class="providerReady ? 'bg-success' : 'bg-warning'"
            />{{
              providerReady
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
          <h2 class="text-lg font-semibold">{{ t('subscriptionsTitle') }}</h2>
          <div class="flex gap-2">
            <button
              class="btn btn-ghost btn-sm"
              :disabled="busy"
              @click="void run(refresh)"
            >
              {{ t('manualNodesRefresh') }}
            </button>
            <button
              class="btn btn-outline btn-sm"
              :disabled="busy || !providerReady"
              @click="healthcheck"
            >
              {{ t('manualNodesHealthcheck') }}
            </button>
          </div>
        </div>
        <div
          v-if="!sources.length"
          class="py-14 text-center text-base-content/60"
        >
          {{ t('subscriptionsEmpty') }}
        </div>
        <div v-else class="mt-4 space-y-3">
          <article
            v-for="source in sources"
            :key="source.id"
            class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-base-content/10 bg-base-100 p-4"
          >
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <h3 class="font-medium">{{ source.name }}</h3>
                <span class="badge badge-ghost badge-sm uppercase">{{
                  source.format
                }}</span
                ><span
                  v-if="source.lastError"
                  class="badge badge-sm badge-warning"
                  >{{ t('subscriptionsUpdateFailed') }}</span
                >
              </div>
              <div class="mt-1 text-xs text-base-content/60">
                {{ source.host }} · {{ source.count }}
                {{ t('manualNodesList') }} · {{ t('subscriptionsLastUpdate') }}
                {{ date(source.lastUpdatedAt) }}
              </div>
              <div class="mt-1 text-xs text-base-content/50">
                {{
                  source.intervalHours
                    ? t('subscriptionsEveryHours', {
                        count: source.intervalHours,
                      })
                    : t('subscriptionsManualOnly')
                }}
              </div>
            </div>
            <div class="flex flex-wrap gap-1">
              <button
                class="btn btn-ghost btn-sm"
                :disabled="busy"
                @click="updateNow(source)"
              >
                {{ t('subscriptionsUpdateNow') }}
              </button>
              <button
                class="btn btn-ghost btn-sm"
                :disabled="busy"
                @click="openEdit(source)"
              >
                {{ t('manualNodesEdit') }}
              </button>
              <button
                class="btn btn-ghost text-error btn-sm"
                :disabled="busy"
                @click="remove(source)"
              >
                {{ t('manualNodesDelete') }}
              </button>
            </div>
          </article>
        </div>
      </section>
    </template>
    <Modal
      ref="formModal"
      :title="editing ? t('manualNodesEdit') : t('subscriptionsAdd')"
      size="xl"
      @close="clearForm"
    >
      <div class="space-y-4">
        <label class="block text-sm"
          >{{ t('subscriptionsName') }}
          <input
            v-model="name"
            class="input-bordered input mt-1 w-full"
            maxlength="80"
            autocomplete="off"
          />
        </label>
        <label class="block text-sm"
          >{{ t('subscriptionsLink') }}
          <input
            v-model="url"
            :type="showUrl ? 'text' : 'password'"
            class="input-bordered input mt-1 w-full font-mono"
            autocomplete="off"
            spellcheck="false"
            @input="preview = null"
          />
        </label>
        <label class="flex items-center gap-2 text-sm"
          ><input
            v-model="showUrl"
            type="checkbox"
            class="checkbox checkbox-sm"
          />{{ t('subscriptionsShowLink') }}</label
        >
        <label class="block text-sm"
          >{{ t('subscriptionsInterval') }}
          <input
            v-model.number="intervalHours"
            type="number"
            min="0"
            max="720"
            class="input-bordered input mt-1 w-full"
          />
          <span class="mt-1 block text-xs text-base-content/55">{{
            t('subscriptionsIntervalHint')
          }}</span>
        </label>
        <div
          v-if="preview"
          class="rounded-xl border border-base-content/10 bg-base-200 p-3"
        >
          <div class="font-medium">
            {{ t('manualNodesPreview') }} · {{ preview.format.toUpperCase() }} ·
            {{ preview.count }} {{ t('manualNodesList') }}
          </div>
          <ul class="mt-2 max-h-48 space-y-1 overflow-auto text-xs">
            <li v-for="(item, index) in preview.items" :key="index">
              {{ item.name }} · {{ item.protocol }} · {{ item.server }}:{{
                item.port
              }}
            </li>
          </ul>
        </div>
      </div>
      <template #actions>
        <button
          class="btn btn-ghost"
          :disabled="busy"
          @click="formModal?.close()"
        >
          {{ t('manualNodesCancel') }}
        </button>
        <button
          class="btn btn-outline"
          :disabled="busy || !url"
          @click="previewLink"
        >
          {{ t('manualNodesPreview') }}
        </button>
        <button
          class="btn btn-primary"
          :disabled="busy || !url || !name"
          @click="save"
        >
          {{ t('manualNodesSave') }}
        </button>
      </template>
    </Modal>
  </div>
</template>
