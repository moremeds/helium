"""Pure specification-model tests. NOT PostgreSQL/Helium integration tests."""
import json
import unittest


def strict_json(text):
    def pairs(items):
        out = {}
        for k, v in items:
            if k in out:
                raise ValueError('duplicate key: ' + k)
            out[k] = v
        return out
    return json.loads(text, object_pairs_hook=pairs)


class SpecificationCounterexamples(unittest.TestCase):
    def test_high_water_cursor_can_miss_late_commit(self):
        visible = [2]  # transaction with id=1 has not committed yet
        cursor = max(visible)
        visible.append(1)
        self.assertEqual([e for e in visible if e > cursor], [])
        acked = {2}
        self.assertEqual([e for e in visible if e not in acked], [1])

    def test_stale_epoch_cannot_finalize(self):
        current_epoch, old_worker_epoch = 2, 1
        allowed = lambda epoch: epoch == current_epoch
        self.assertFalse(allowed(old_worker_epoch))
        self.assertTrue(allowed(2))

    def test_immutable_pass_can_become_ineligible(self):
        receipt = {'result': 'PASS', 'epoch': 4}
        active_epoch = 5  # evidence correction has committed
        self.assertEqual(receipt['result'], 'PASS')
        self.assertFalse(receipt['epoch'] == active_epoch)

    def test_unknown_dispatch_keeps_reservation(self):
        limit, spent, reserved = 10, 3, 6
        timeout_status = 'UNKNOWN'
        if timeout_status == 'CONFIRMED_NOT_DISPATCHED':
            reserved = 0
        self.assertFalse(spent + reserved + 2 <= limit)

    def test_campaign_rename_does_not_reset_exposure(self):
        consumed_lineages = {frozenset(['case-a', 'case-b'])}
        new_name_same_cases = frozenset(['case-b', 'case-a'])
        self.assertIn(new_name_same_cases, consumed_lineages)

    def test_grant_expiry_does_not_revoke_config_implicitly(self):
        auto_grant_valid, configuration_approved = False, True
        self.assertFalse(auto_grant_valid)
        self.assertTrue(configuration_approved)

    def test_target_and_execution_are_separate(self):
        binding = {'target': 'production', 'execution': 'evaluation', 'delivery': 'disabled'}
        self.assertNotEqual(binding['target'], binding['execution'])
        self.assertEqual(binding['delivery'], 'disabled')

    def test_unknown_delivery_is_not_retry_permission(self):
        state, supports_reconcile, supports_idempotency = 'UNKNOWN', False, False
        can_retry = state == 'CONFIRMED_NOT_SENT' or supports_reconcile or supports_idempotency
        self.assertFalse(can_retry)

    def test_raw_duplicate_keys_rejected(self):
        raw = '{"perStock":2,"perStock":3}'
        self.assertEqual(json.loads(raw)['perStock'], 3)
        with self.assertRaises(ValueError):
            strict_json(raw)

    def test_attempts_do_not_become_independent_trials(self):
        attempts = [{'trial': 't1'}, {'trial': 't1'}, {'trial': 't2'}]
        self.assertEqual(len(attempts), 3)
        self.assertEqual(len({a['trial'] for a in attempts}), 2)


if __name__ == '__main__':
    unittest.main(verbosity=2)
