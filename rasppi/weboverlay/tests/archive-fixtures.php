<?php
declare(strict_types=1);

// Artificial values only; shared by pure tests and disposable MariaDB tests.
function archiveFixture(int $start, int $resolution = 60, int $samples = 2, int $power = 1000): array
{
    $metrics = [];
    $means = ['active_power_w', 'current_l1_a', 'current_l2_a', 'current_l3_a', 'voltage_l1_v', 'voltage_l2_v', 'voltage_l3_v'];
    foreach (\EvseOverlay\HistoryArchive::METRICS as $key) {
        $value = match ($key) {
            'active_power_w' => (string) $power, 'session_energy_wh' => '2000', 'current_limit_a' => '6',
            'plugged_in' => '1', 'charging', 'below_commanded_current' => '0', default => '1',
        };
        $metrics[$key] = ['n' => $samples, 'nulls' => 0, 'sum' => in_array($key, $means, true) ? (string) ((int) $value * $samples) : null,
            'min' => $value, 'max' => $value, 'first' => $value, 'last' => $value, 'mixed' => false];
    }
    $data = ['schema_version' => 1, 'samples' => $samples, 'valid_samples' => $samples, 'error_samples' => 0, 'retained_samples' => 0,
        'first_at' => gmdate('Y-m-d\TH:i:s', $start) . '.000000Z', 'last_at' => gmdate('Y-m-d\TH:i:s', $start + $resolution - 2) . '.000000Z',
        'has_gap' => false, 'complete' => true, 'coverage_seconds' => (string) $resolution, 'metrics' => $metrics];
    return ['resolution_seconds' => (string) $resolution, 'bucket_start' => gmdate('Y-m-d H:i:s', $start) . '.000000',
        'data_json' => json_encode($data, JSON_THROW_ON_ERROR)];
}

function archiveMutate(array $row, callable $operation): array
{
    $data = json_decode($row['data_json'], true, 64, JSON_THROW_ON_ERROR);
    $operation($data);
    $row['data_json'] = json_encode($data, JSON_THROW_ON_ERROR);
    return $row;
}

function archiveAssert(bool $condition, string $label = 'Archive check failed'): void
{
    if (!$condition) { throw new RuntimeException($label); }
}

function archiveReject(callable $operation): void
{
    try { $operation(); } catch (Throwable) { return; }
    throw new RuntimeException('Expected archive rejection');
}
