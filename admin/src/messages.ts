import { useIntl } from 'react-intl'

import en from './translations/en.json'

type MessageId = keyof typeof en

/** The translator of the plugin's admin strings, with the English text as the default. */
export interface Messages {
  /** The message `id`, filled with `values`; an id with no English text shows the id. */
  t: (id: string, values?: Record<string, string | number>) => string
  /** A date and time, in the admin language. */
  date: (iso: string) => string
}

/** `formatMessage` with the English text as the default, so the plugin reads right before the admin loads a locale. */
export function useMessages(): Messages {
  const { formatMessage, formatDate } = useIntl()
  return {
    t: (id, values) => formatMessage({ id, defaultMessage: en[id as MessageId] ?? id }, values),
    date: (iso) => formatDate(iso, { dateStyle: 'medium', timeStyle: 'short' }),
  }
}
