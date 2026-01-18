#!/bin/bash

on_exit() {
    exit_code=$?
    if [ $exit_code -eq 0 ]; then
        aws stepfunctions send-task-success --task-token "@TASK_TOKEN@" \
            --task-output '{"id": "'`curl -s http://169.254.169.254/latest/meta-data/instance-id`'"}'
    else
        aws stepfunctions send-task-failure --task-token "@TASK_TOKEN@" \
            --error "EC2.Instance.UserDataExitCode-$exit_code" \
            --cause "`tail -c 32768 @LOGFILE@`"
    fi
}
trap on_exit EXIT

set -o pipefail
{
    @SCRIPT@
} 2>&1 | tee -a @LOGFILE@
