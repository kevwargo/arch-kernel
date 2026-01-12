import json
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import boto3

TAG_RESOURCE_ID = "kbuild-custom-resource-id"
FIELD_INSTANCE_ID = "SourceInstanceId"

ec2 = boto3.client("ec2")
ssm = boto3.client("ssm")


def on_create(event):
    resource_id = str(uuid4())
    props = event["ResourceProperties"]
    log(f"on_create: generated new resource ID {resource_id}", props=props)

    tags = [
        {
            "Key": "Name",
            "Value": "kbuild-image-custom-resource",
        },
        {
            "Key": TAG_RESOURCE_ID,
            "Value": resource_id,
        },
    ]

    instance = ec2.run_instances(
        ImageId=props["SourceImageId"],
        MinCount=1,
        MaxCount=1,
        InstanceType="t3.small",
        SecurityGroupIds=[props["SecurityGroupId"]],
        TagSpecifications=[
            {"ResourceType": "instance", "Tags": tags},
        ],
        UserData=(Path(__file__).parent / "user-data.sh").read_text(),
    )["Instances"][0]
    log("on_create: created EC2 instance", instance=instance)

    volume = ec2.create_volume(
        AvailabilityZone=instance["Placement"]["AvailabilityZone"],
        Size=20,
        VolumeType="gp3",
        TagSpecifications=[
            {"ResourceType": "volume", "Tags": tags},
        ],
    )
    log("on_create: created volume", volume=volume)

    return {
        "PhysicalResourceId": resource_id,
        "Data": {
            "ImageId": "ami-xxx",
            "VolumeId": volume["VolumeId"],
        },
        FIELD_INSTANCE_ID: instance["InstanceId"],
    }


def on_update(event):
    return {"PhysicalResourceId": event["PhysicalResourceId"]}


def on_delete(event):
    return {"PhysicalResourceId": event["PhysicalResourceId"]}


def is_complete(event, _):
    log("Handler: is_complete", event=event)

    if event["RequestType"] != "Create":
        resp = {"IsComplete": True}
        if data := event.get("Data"):
            resp["Data"] = data
        return resp

    instance_id = event[FIELD_INSTANCE_ID]
    volume_id = event["Data"]["VolumeId"]
    log("checking status", instance_id=instance_id, volume_id=volume_id)

    volumes = ec2.describe_volumes(VolumeIds=[volume_id]).get("Volumes")
    if not volumes:
        raise ValueError(f"Volume {volume_id} not found")
    if (vol_state := volumes[0]["State"]) == "creating":
        log("volume not ready", volume=volumes[0])
        return {"IsComplete": False}
    if vol_state != "available":
        raise ValueError(f"Invalid state {vol_state} for volume {volume_id}")

    ssm_instances = ssm.describe_instance_information(
        Filters=[{"Key": "InstanceIds", "Values": [instance_id]}]
    ).get("InstanceInformationList")
    if not ssm_instances:
        log("instance is not yet registered in SSM")
        return {"IsComplete": False}
    if ssm_instances[0]["PingStatus"] != "Online":
        log("instance is not yet online", ssm_instance=ssm_instances[0])
        return {"IsComplete": False}

    return {
        "IsComplete": True,
        "Data": event["Data"] | {"ImageId": "ami-new-xxyyzz"},
    }


def on_event(event, _):
    log("Handler: on_event", event=event)

    return {
        "Create": on_create,
        "Update": on_update,
        "Delete": on_delete,
    }[
        event["RequestType"]
    ](event)


def log(msg: str, **fields):
    print(json.dumps({"time": datetime.now(UTC), "msg": msg, **fields}, default=str))
