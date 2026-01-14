import json
from datetime import UTC, datetime
from uuid import uuid4

import boto3

TAG_RESOURCE_ID = "image-build-custom-resource-id"
FIELD_INSTANCE_ID = "SourceInstanceId"

ec2 = boto3.client("ec2")


def on_create(event):
    resource_id = str(uuid4())
    props = event["ResourceProperties"]
    log(f"on_create: generated new resource ID {resource_id}", props=props)

    params = dict(
        ImageId=props["SourceImageId"],
        MinCount=1,
        MaxCount=1,
        InstanceType="t3.small",
        SecurityGroupIds=[props["SecurityGroupId"]],
        IamInstanceProfile={"Arn": props["InstanceProfileArn"]},
        UserData=props["UserData"],
        TagSpecifications=[
            {
                "ResourceType": "instance",
                "Tags": [
                    {
                        "Key": "Name",
                        "Value": f"image-build-{resource_id}",
                    },
                    {
                        "Key": TAG_RESOURCE_ID,
                        "Value": resource_id,
                    },
                ],
            },
        ],
    )

    if size := props.get("RootVolumeSize"):
        params["BlockDeviceMappings"] = [
            {
                "DeviceName": "/dev/xvda",
                "Ebs": {"VolumeSize": int(size)},
            }
        ]
    if key_name := props.get("KeyName"):
        params["KeyName"] = key_name

    log("on_create: running instance", params=params)

    instance = ec2.run_instances(**params)["Instances"][0]
    log("on_create: created EC2 instance", instance=instance)

    return {
        "PhysicalResourceId": resource_id,
        "Data": {
            "ImageId": "ami-xxx",
        },
        FIELD_INSTANCE_ID: instance["InstanceId"],
    }


def on_update(event):
    return {"PhysicalResourceId": event["PhysicalResourceId"]}


def on_delete(event):
    resource_id = event["PhysicalResourceId"]

    terminate_instances = []
    for page in ec2.get_paginator("describe_instances").paginate(
        Filters=[{"Name": f"tag:{TAG_RESOURCE_ID}", "Values": [resource_id]}]
    ):
        for res in page["Reservations"]:
            for instance in res["Instances"]:
                terminate_instances.append(instance)

    if terminate_instances:
        log("terminating leftover instances", instances=terminate_instances)
        ec2.terminate_instances(InstanceIds=[i["InstanceId"] for i in terminate_instances])

    return {"PhysicalResourceId": resource_id}


def is_create_complete(event):
    instance_id = event[FIELD_INSTANCE_ID]
    log("checking status", instance_id=instance_id)

    try:
        instance = ec2.describe_instances(InstanceIds=[instance_id])["Reservations"][0][
            "Instances"
        ][0]
    except (KeyError, IndexError, TypeError) as e:
        raise ValueError(f"Cannot find instance {instance_id}: {type(e).__name__}({e})") from e

    for tag in instance.get("Tags") or []:
        if tag["Key"] == "image-build-exit-code":
            if tag["Value"] == "0":
                return {
                    "IsComplete": True,
                    "Data": {"ImageId": "ami-new-xyz"},
                }
            raise ValueError(f'Instance script failed with error code {tag["Value"]}')

    return {"IsComplete": False}


def is_update_complete(event):
    resp = {"IsComplete": True}
    if "Data" in event:
        resp["Data"] = event["Data"]
    return resp


def is_delete_complete(event):
    is_complete = True
    for page in ec2.get_paginator("describe_instances").paginate(
        Filters=[{"Name": f"tag:{TAG_RESOURCE_ID}", "Values": [event["PhysicalResourceId"]]}]
    ):
        for res in page["Reservations"]:
            for instance in res["Instances"]:
                if instance["State"]["Name"] != "terminated":
                    is_complete = False
                    log("leftover instance is still alive", instance=instance)

    return {"IsComplete": is_complete}


def on_event(event, _):
    log("Handler: on_event", event=event)

    return {
        "Create": on_create,
        "Update": on_update,
        "Delete": on_delete,
    }[
        event["RequestType"]
    ](event)


def is_complete(event, _):
    log("Handler: is_complete", event=event)

    return {
        "Create": is_create_complete,
        "Update": is_update_complete,
        "Delete": is_delete_complete,
    }[event["RequestType"]](event)


def log(msg: str, **fields):
    print(json.dumps({"msg": msg, "time": datetime.now(UTC), **fields}, default=str))
