import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ServeEditor } from '@/pages/flags/ServeEditor'
import type { Variation } from '@/types/api'

const variations: Variation[] = [
  { id: '11111111-1111-1111-1111-111111111111', value: 'true' },
  { id: '22222222-2222-2222-2222-222222222222', value: 'false' },
]

describe('ServeEditor', () => {
  it('surfaces the live sum error when the weights do not total 100', () => {
    render(
      <ServeEditor
        idPrefix="fallthrough"
        label="Default"
        variations={variations}
        value={{
          rollout: [
            { variationId: variations[0].id, weight: 25 },
            { variationId: variations[1].id, weight: 25 },
          ],
        }}
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByTestId('fallthrough-weight-sum')).toHaveTextContent(
      'Weights total 50% — add 50%',
    )
  })

  it('reports a clean total when the weights are valid', () => {
    render(
      <ServeEditor
        idPrefix="fallthrough"
        label="Default"
        variations={variations}
        value={{
          rollout: [
            { variationId: variations[0].id, weight: 25 },
            { variationId: variations[1].id, weight: 75 },
          ],
        }}
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByTestId('fallthrough-weight-sum')).toHaveTextContent('Weights total 100%')
  })

  it('rebalances to 100 when one weight is edited', () => {
    const onChange = vi.fn()
    render(
      <ServeEditor
        idPrefix="fallthrough"
        label="Default"
        variations={variations}
        value={{
          rollout: [
            { variationId: variations[0].id, weight: 50 },
            { variationId: variations[1].id, weight: 50 },
          ],
        }}
        onChange={onChange}
      />,
    )
    // The editor is controlled: it reports the rebalanced set upward rather than holding
    // its own copy, so the assertion is on what it hands the parent.
    fireEvent.change(screen.getByTestId('fallthrough-weight-0'), { target: { value: '3' } })
    expect(onChange).toHaveBeenCalledWith({
      rollout: [
        { variationId: variations[0].id, weight: 3 },
        { variationId: variations[1].id, weight: 97 },
      ],
    })
  })

  it('renders a single-variation serve without any rollout controls', () => {
    render(
      <ServeEditor
        idPrefix="rule-0"
        label="Serve"
        variations={variations}
        value={{ variationId: variations[0].id }}
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByTestId('rule-0-variation')).toBeInTheDocument()
    expect(screen.queryByTestId('rule-0-weight-sum')).not.toBeInTheDocument()
  })
})
