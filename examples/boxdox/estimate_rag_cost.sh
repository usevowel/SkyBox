#!/usr/bin/env bash
# Cloudflare RAG Cost Estimator for BoxDox
set -euo pipefail

DOCS_DIR="${1:-/home/k/Git/BoxLang/box-dox/content}"
CHUNK_SIZE=500
CHUNK_OVERLAP=50
VECTOR_DIMS=768
QUERIES_PER_DAY=1000
DAYS=30

echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║     Cloudflare RAG Cost Estimator — BoxDox Docs             ║"
echo "╚═══════════════════════════════════════════════════════════════╝"

TEXT_FILES=$(find "$DOCS_DIR" -type f \( -name '*.md' -o -name '*.mdx' -o -name '*.html' -o -name '*.txt' \) 2>/dev/null | wc -l)
TOTAL_CHARS=$(find "$DOCS_DIR" -type f \( -name '*.md' -o -name '*.mdx' -o -name '*.html' -o -name '*.txt' \) -exec cat {} + 2>/dev/null | wc -c)
TOTAL_LINES=$(find "$DOCS_DIR" -type f \( -name '*.md' -o -name '*.mdx' -o -name '*.html' -o -name '*.txt' \) -exec wc -l {} + 2>/dev/null | tail -1 | awk '{print $1}')

EFFECTIVE_PER_CHUNK=$(( CHUNK_SIZE - CHUNK_OVERLAP ))
ESTIMATED_CHUNKS=$(( TOTAL_CHARS / EFFECTIVE_PER_CHUNK + TEXT_FILES/2 + 1 ))
BATCH_SIZE=100
EMBED_API_CALLS=$(( (ESTIMATED_CHUNKS + BATCH_SIZE - 1) / BATCH_SIZE ))

echo ""
echo "── Content ──"
echo "  Text files:    $TEXT_FILES"
echo "  Total chars:   $TOTAL_CHARS  ($((TOTAL_CHARS/1024)) KB)"
echo "  Est. chunks:   $ESTIMATED_CHUNKS"

echo ""
echo "── Embeddings (Workers AI — @cf/baai/bge-base-en-v1.5) ──"
awk -v calls=$EMBED_API_CALLS -v queries=$QUERIES_PER_DAY -v days=$DAYS '
BEGIN {
    seed_cost = calls / 1000 * 0.001;
    daily_cost = queries / 1000 * 0.001;
    monthly_q = daily_cost * days;
    printf "  Batch calls (seed): %d\n", calls;
    printf "  Seed cost:          $%.4f\n", seed_cost;
    printf "  Daily query embed:  $%.6f\n", daily_cost;
    printf "  Monthly query:      $%.4f\n", monthly_q;
}
'

echo ""
echo "── Vectorize Storage ($VECTOR_DIMS dims) ──"
FREE_SLOTS=5000000
FREE_VECTORS=$(( FREE_SLOTS / VECTOR_DIMS ))
PAID_VECTORS=$(( ESTIMATED_CHUNKS > FREE_VECTORS ? ESTIMATED_CHUNKS - FREE_VECTORS : 0 ))

awk -v free=$FREE_VECTORS -v paid=$PAID_VECTORS -v chunks=$ESTIMATED_CHUNKS -v queries=$QUERIES_PER_DAY -v days=$DAYS '
BEGIN {
    store_cost = paid / 1000000 * 0.80;
    write_cost = chunks / 1000000 * 0.80;
    read_daily = queries / 1000000 * 3.50;
    read_monthly = read_daily * days;
    printf "  Free vectors:    %d\n", free;
    if (paid > 0) printf "  Paid vectors:    %d @ $0.80/million/month\n", paid;
    printf "  Storage cost:    $%.4f/month\n", store_cost;
    printf "  Seed write cost: $%.4f\n", write_cost;
    printf "  Query cost:      $%.6f/day → $%.4f/month\n", read_daily, read_monthly;
}
'

echo ""
echo "── D1 Database ──"
D1_WRITE_DAILY=$(( QUERIES_PER_DAY / 100 ))
awk -v chunks=$ESTIMATED_CHUNKS -v wdaily=$D1_WRITE_DAILY -v days=$DAYS '
BEGIN {
    storage_mb = chunks * 600 / 1024 / 1024;
    wmonthly = wdaily * days / 1000000 * 0.75;
    printf "  Storage:    %.1f MB (5 GB free)\n", storage_mb;
    printf "  Reads/day:  %d (100k free)\n", 1000;
    printf "  Writes/day: %d (100k free)\n", wdaily;
    printf "  D1 cost:    $0.00 (free tier)\n";
}
'

echo ""
echo "── Workers Runtime ──"
MONTHLY_REQS=$(( (QUERIES_PER_DAY + 100) * DAYS ))
if [ "$MONTHLY_REQS" -le 100000 ]; then
    echo "  Requests/month: $MONTHLY_REQS → \$0 (free)"
else
    awk -v reqs=$MONTHLY_REQS '
    BEGIN {
        paid = reqs - 100000;
        cost = 5 + paid / 1000000 * 0.30;
        printf "  Requests/month: %d\n", reqs;
        printf "  Workers cost:   $%.2f/month ($5 base + $0.30/M beyond 100k)\n", cost;
    }
    '
fi

echo ""
echo "═════════════════════════════════════════════════════════════════"
echo "  TOTAL (30 days, $QUERIES_PER_DAY queries/day)"
echo "═════════════════════════════════════════════════════════════════"
awk -v calls=$EMBED_API_CALLS -v chunks=$ESTIMATED_CHUNKS -v queries=$QUERIES_PER_DAY -v days=$DAYS -v paid_vec=$PAID_VECTORS '
BEGIN {
    embed_seed    = calls / 1000 * 0.001;
    vec_write     = chunks / 1000000 * 0.80;
    vec_storage   = paid_vec / 1000000 * 0.80;
    vec_queries   = queries / 1000000 * 3.50 * days;
    embed_monthly = queries / 1000 * 0.001 * days;
    one_time      = embed_seed + vec_write;
    monthly       = vec_storage + vec_queries + embed_monthly;
    grand         = one_time + monthly;

    printf "\n  One-time seeding:\n";
    printf "    Embeddings:          $%.4f\n", embed_seed;
    printf "    Vectorize upserts:   $%.4f\n", vec_write;
    printf "    ----------------------------\n";
    printf "    TOTAL:               $%.4f\n", one_time;

    printf "\n  Monthly recurring:\n";
    printf "    Vectorize storage:   $%.4f\n", vec_storage;
    printf "    Vectorize queries:   $%.4f\n", vec_queries;
    printf "    Query embeddings:    $%.4f\n", embed_monthly;
    printf "    D1 + Workers:        $0.00 (free tier)\n";
    printf "    ----------------------------\n";
    printf "    TOTAL:               $%.4f\n", monthly;

    printf "\n  Grand total (first month): $%.4f\n", grand;
}
'
echo ""
echo "  Free tier covers the entire boxdox RAG at this scale."
echo "  Only paid if exceeding: 10k embed reqs/day, 5M vector slots, 100k D1 reads/day"
echo "═════════════════════════════════════════════════════════════════"
