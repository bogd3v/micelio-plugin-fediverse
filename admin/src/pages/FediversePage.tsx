import { Flex } from '@strapi/design-system'
import { Layouts } from '@strapi/strapi/admin'

import { DiagnosticsSection } from '../components/DiagnosticsSection'
import { FailuresSection } from '../components/FailuresSection'
import { FollowersSection } from '../components/FollowersSection'
import { useMessages } from '../messages'

/** The Fediverse page of the admin: diagnostics, followers and failed deliveries. */
export default function FediversePage() {
  const { t } = useMessages()
  return (
    <Layouts.Root>
      <Layouts.Header title={t('fediverse.page.title')} subtitle={t('fediverse.page.subtitle')} />
      <Layouts.Content>
        <Flex direction="column" alignItems="stretch" gap={6}>
          <DiagnosticsSection />
          <FollowersSection />
          <FailuresSection />
        </Flex>
      </Layouts.Content>
    </Layouts.Root>
  )
}
