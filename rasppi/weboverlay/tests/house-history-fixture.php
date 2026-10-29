<?php
declare(strict_types=1);

// TEST ONLY: launched by compose.house-api-test.yaml in the disposable DB's
// network namespace. Runtime code never imports this helper or performs DDL.
umask(0077);

function fixtureSecret(string $path, string $contents): void
{
    // Exclusive create: do not follow a pre-existing path or overwrite secrets.
    $file = fopen($path, 'x');
    if ($file === false) {
        throw new RuntimeException('Fixture secret creation failed');
    }
    try {
        if (fwrite($file, $contents) !== strlen($contents) || !chmod($path, 0400)) {
            throw new RuntimeException('Fixture secret write failed');
        }
    } finally {
        fclose($file);
    }
}

try {
    $required = [
        'HOUSE_TEST_ISOLATED' => '1',
        'HOUSE_TEST_DB' => 'evse_house_test',
        'HOUSE_TEST_EMPTY_DB' => 'evse_house_test_empty',
        'HOUSE_TEST_ROOT_PASSWORD' => 'dummy-only-house-root',
        'HOUSE_TEST_ADMIN_FILE' => '/tmp/house-admin.cnf',
        'HOUSE_TEST_READER_FILE' => '/tmp/house-reader.cnf',
        'HISTORY_DB_HOST' => '127.0.0.1',
        'HISTORY_DB_PORT' => '3306',
        'HISTORY_DB_NAME' => 'evse_house_test',
        'HISTORY_DB_USERNAME' => 'house_reader',
        'HISTORY_DB_PASSWORD_FILE' => '/tmp/house-reader-password',
    ];
    foreach ($required as $key => $value) {
        if (getenv($key) !== $value) {
            throw new RuntimeException('Disposable fixture settings required');
        }
    }
    $migration = file_get_contents('/fixtures/003_house.sql');
    if ($migration === false || $migration === '') {
        throw new RuntimeException('Mounted fixture migration required');
    }
    $db = new PDO('mysql:host=127.0.0.1;port=3306;charset=utf8mb4', 'root', $required['HOUSE_TEST_ROOT_PASSWORD'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_EMULATE_PREPARES => false,
        PDO::ATTR_TIMEOUT => 2,
        PDO::MYSQL_ATTR_MULTI_STATEMENTS => false,
    ]);
    $db->exec("SET time_zone='+00:00'");
    $db->exec('CREATE DATABASE evse_house_test CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');
    $db->exec('CREATE DATABASE evse_house_test_empty CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');
    $db->exec('USE evse_house_test');
    // The checked-in migration contains only semicolon-delimited CREATE TABLEs.
    foreach (explode(';', $migration) as $statement) {
        if (trim($statement) !== '') {
            $db->exec($statement);
        }
    }
    $registry = $db->prepare('INSERT INTO evse_house_schema_versions(version,checksum,applied_at) VALUES (1,UNHEX(?),UTC_TIMESTAMP(6))');
    $registry->execute([hash('sha256', $migration)]);
    $tables = ['evse_house_buckets', 'evse_house_events', 'evse_house_samples', 'evse_house_schema_versions', 'evse_house_work'];
    $actual = $db->query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='evse_house_test' ORDER BY TABLE_NAME")->fetchAll(PDO::FETCH_COLUMN);
    if ($actual !== $tables) {
        throw new RuntimeException('Unexpected fixture schema');
    }
    $password = bin2hex(random_bytes(32));
    // Only this fixture receives administrative grants. The API uses SELECT-only.
    $db->exec("CREATE USER 'house_reader'@'127.0.0.1' IDENTIFIED BY " . $db->quote($password));
    foreach ($tables as $table) {
        $db->exec("GRANT SELECT ON evse_house_test.$table TO 'house_reader'@'127.0.0.1'");
    }
    $db->exec("GRANT SELECT ON evse_house_test_empty.* TO 'house_reader'@'127.0.0.1'");
    $db = null;

    $defaults = static fn(string $user, string $secret): string =>
        "[client]\nhost=127.0.0.1\nport=3306\nprotocol=tcp\nuser=$user\npassword=$secret\ndatabase=evse_house_test\n";
    fixtureSecret('/tmp/house-admin.cnf', $defaults('root', $required['HOUSE_TEST_ROOT_PASSWORD']));
    fixtureSecret('/tmp/house-reader.cnf', $defaults('house_reader', $password));
    fixtureSecret('/tmp/house-reader-password', $password . "\n");
    print "Disposable HOUSE API fixture ready\n";
} catch (Throwable) {
    // Never expose SQL, connection strings, filesystem contents or credentials.
    fwrite(STDERR, "Disposable HOUSE API fixture failed (diagnostics withheld)\n");
    exit(1);
}
