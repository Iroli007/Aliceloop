#!/bin/bash
# 漏洞修复验证脚本

echo "=========================================="
echo "  🔒 Sandbox 漏洞修复验证"
echo "=========================================="
echo ""

cd /Users/raper/workspace/Projects/Aliceloop/apps/daemon

# 测试用例：命令 -> 是否应该被拦截
declare -A tests=(
  ["find /etc -type f"]="BLOCK"
  ["find /Users/raper/tmp -type f"]="BLOCK"
  ["find -exec cat /etc/passwd \\;"]="BLOCK"
  ["find . -name '*.ts'"]="ALLOW"
  ["find src -name '*.ts'"]="ALLOW"
  ["cat src/services/sandboxExecutor.ts"]="ALLOW"
)

passed=0
failed=0

for test in "${!tests[@]}"; do
  expected=${tests[$test]}
  
  result=$(npm run sandbox -- "$test" 2>&1)
  exit_code=$?
  
  if [[ "$expected" == "BLOCK" ]]; then
    if echo "$result" | grep -qi "error\|denied\|not allowed\|no permission"; then
      echo "✅ PASS | $test"
      ((passed++))
    else
      echo "❌ FAIL | $test | 期望拦截，实际放行"
      ((failed++))
    fi
  else
    if [[ $exit_code -eq 0 ]]; then
      echo "✅ PASS | $test"
      ((passed++))
    else
      echo "❌ FAIL | $test | 期望放行，实际拦截"
      ((failed++))
    fi
  fi
done

echo ""
echo "=========================================="
echo "  结果: $passed 通过, $failed 失败"
echo "=========================================="
